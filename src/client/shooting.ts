import { GUNS, WORLD, type GunId } from '../shared/defs.ts';
import { doorsOf } from './predict.ts';
import { leavesFromViews } from '../shared/sim/doors.ts';
import type { Snapshot } from '../shared/protocol.ts';
import { rangeFor, silencedFor } from '../shared/sim/stats.ts';
import { noteLateShot, noteRejectedShot } from './devprobe.ts';
import { gunFxOf, muzzleFlash } from './gunfx.ts';
import { dueAt, serverGun, settle, spreadOf, type PredictedShot, type TriggerInput } from './fire.ts';
import { newestSnap, renderTime, sampleAt, TICK_MS } from './interp.ts';
import { fireRounds, roundScene, type Shot, type ShotEvent } from './rounds.ts';
import { shotCue, type SoundCue } from './sfx.ts';
import { muzzleTip } from './gunart.ts';
import type { Session } from './state.ts';
import { raiseWatch } from './raise.ts';
import { emitSfxAt } from './sfxbus.ts';

type Point = { x: number; y: number };
type Offset = { dx: number; dy: number };

export type Hands = { active: boolean; firing: boolean; touchAim: Offset | null; reload: boolean; sinceMove: number; aim: Offset };

const unperkedShot = (ev: ShotEvent): Shot => ({ owner: ev.owner, gun: ev.gun, range: GUNS[ev.gun].range, spread: GUNS[ev.gun].spread });

type Page = {
  hands: (s: Session) => Hands;
  playCues: (s: Session, cues: readonly SoundCue[], viewRadius: number) => void;
  /** Your own shot left toward `angle`, for the camera's recoil. */
  recoil: (gun: GunId, angle: number) => void;
};

export function createShooting(page: Page) {
  let nextLocalRoundId = -1;
  let touchAiming = false;

  function showShot(s: Session, shot: Shot, at: Point, angle: number, seen: Snapshot, now: number): number[] {
    const muzzle = muzzleTip(at.x, at.y, angle, shot.gun, WORLD.playerRadius);
    const rounds = fireRounds(shot, muzzle, angle, roundScene(seen, [...s.walls, ...leavesFromViews(doorsOf(s), seen.doors)], shot.owner), now, nextLocalRoundId);
    nextLocalRoundId -= rounds.length;
    s.rounds.push(...rounds);
    // The flash effect still times the shooter's recoil kick; gunfx draws the flash and ejects the casing.
    s.effects.push({ kind: 'flash', ...muzzle, angle, owner: shot.owner, born: now });
    muzzleFlash(gunFxOf(s), muzzle, angle, shot.gun, now);
    return rounds.map((r) => r.id);
  }

  function fireOwnShot(s: Session, snap: Snapshot, gun: GunId, silenced: boolean, now: number): number[] {
    const { aim } = page.hands(s);
    const shot = { owner: s.myId, gun, range: rangeFor(gun, snap.self.perks), spread: spreadOf(s.firing) };
    page.playCues(s, [shotCue(gun, silenced, s.lastSelf, true)], snap.self.viewRadius || WORLD.viewRadius);
    const angle = Math.atan2(aim.dy, aim.dx);
    page.recoil(gun, angle);
    return showShot(s, shot, s.lastSelf, angle, sampleAt(s.snaps.snaps, renderTime(s.snaps, now)) ?? snap, now);
  }

  function triggerInput(s: Session): TriggerInput {
    const h = page.hands(s);
    return { fire: h.active && (h.firing || h.touchAim !== null), shots: s.shots, reload: h.active && h.reload };
  }

  function fireAheadBy(s: Session, now: number, dueBy: number) {
    const due = dueAt(s.firing, triggerInput(s));
    const snap = newestSnap(s.snaps);
    if (due === null || due > dueBy || !snap) return;
    const { gun } = s.firing.trigger;
    const rounds = fireOwnShot(s, snap, gun, silencedFor(gun, snap.self.perks), now);
    s.firing = { ...s.firing, ahead: { seq: s.firing.sent.seq + 1, rounds } };
  }

  const fireIfDue = (s: Session, now: number) => fireAheadBy(s, now, now);

  function takeBack(s: Session, shot: PredictedShot) {
    s.rounds = s.rounds.filter((r) => !shot.rounds.includes(r.id));
    noteRejectedShot();
  }

  return {
    fireIfDue,
    fireBeforeSending: (s: Session, now: number) => fireAheadBy(s, now, Infinity),
    takeBack,

    pullTouchTrigger(s: Session): boolean {
      const h = page.hands(s);
      const aiming = h.active && h.touchAim !== null;
      if (aiming && !touchAiming) {
        if (raiseWatch.click(s.firing, performance.now())) emitSfxAt('notReady', s.lastSelf.x, s.lastSelf.y, true);
        s.shots++;
        fireIfDue(s, performance.now());
      }
      touchAiming = aiming;
      return aiming;
    },

    settleShots(s: Session, snap: Snapshot, now: number) {
      const own: ShotEvent[] = [];
      for (const ev of snap.events) {
        if (ev.e !== 'shot') continue;
        s.lastShotAt.set(ev.owner, snap.tick * TICK_MS);
        if (ev.owner === s.myId) own.push(ev);
        else s.pendingShots.push({ at: snap.tick * TICK_MS, shot: ev });
      }
      const settled = settle(s.firing, serverGun(snap), snap.ackSeq, own.length, s.predict.pending.map((p) => ({ seq: p.seq, input: { ...p.input, dashing: !!p.dashing } })));
      s.firing = settled.firing;
      settled.rejected.forEach((shot) => takeBack(s, shot));
      for (const ev of own.slice(own.length - settled.unmatched)) {
        fireOwnShot(s, snap, ev.gun, ev.silenced, now);
        noteLateShot();
      }
    },

    fireOthersShot(s: Session, ev: ShotEvent, seen: Snapshot, now: number) {
      const p = seen.players.find((q) => q.id === ev.owner && q.alive);
      showShot(s, unperkedShot(ev), p ?? ev, p?.angle ?? ev.angle, seen, now);
    },
  };
}
