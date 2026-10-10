import { GUNS, MEDALS, STREAK, WORLD, ZOMBIES, type Badge, type MedalId } from '../shared/defs.ts';
import type { Snapshot } from '../shared/protocol.ts';
import { selfOf, type KillEvent } from './derive.ts';
import { TICK_MS } from './interp.ts';
import { PALETTE } from './palette.ts';
import { royaleCallouts } from './royale.ts';
import { runCallouts, squadShare, type RunCallout } from './zombies.ts';

const TONE: Record<RunCallout['tone'], string> = { night: '#a08cff', dawn: PALETTE.gold, warn: '#ff9f43' };

/** A centered announcement; `ring` also bursts a ring around your player. */
export type Callout = { title: string; line: string; color: string; ring: boolean; born: number };
/** A number floating up off the world: score in gold by default, or `text` in `color`, such as the health a kill gave back, which rides with you (`onSelf`). */
export type ScorePopup = { x: number; y: number; amount: number; born: number; text?: string; color?: string; onSelf?: boolean };
/** A medal you earned this match, or a lifetime medal you just unlocked, shown as a toast from `born` (see medaltoasts.ts). */
export type MedalToast = { k: 'medal'; medal: MedalId; born: number } | { k: 'career'; badge: Badge; score: number; born: number };
/** `best` is the streak record already beaten this life. */
export type Moments = { callouts: Callout[]; popups: ScorePopup[]; medals: MedalToast[]; best: boolean };

export const NO_MOMENTS: Moments = { callouts: [], popups: [], medals: [], best: false };

export const MOMENT_COLORS = { best: '#5ee0a0', heal: '#5ee0a0' } as const;
/** How long a medal toast stays up, and how far apart medals earned together land, so each one gets its own beat. */
export const MEDAL_MS = 2600;
export const CAREER_TOAST_MS = 4200;
export const MEDAL_STAGGER_MS = 420;
export const CALLOUT_MS = 2400;
export const RING_MS = 700;
export const POPUP_MS = 1100;
/** Moments that land together queue this far apart, so at most two callouts share the screen and none reaches the player. */
export const CALLOUT_STAGGER_MS = 1200;

const HUNTED_LINE = `Every enemy sees you on the minimap. Your killer earns +${WORLD.bountyScore}.`;

/** When the next toast may land: now, or a beat after the last one queued. */
export const nextToastAt = (toasts: readonly MedalToast[], now: number) => Math.max(now, (toasts.at(-1)?.born ?? -Infinity) + MEDAL_STAGGER_MS);

/** A lifetime medal the server just announced joins the queue, after whatever medals are already landing. */
export const addCareerToast = (m: Moments, badge: Badge, score: number, now: number): Moments =>
  ({ ...m, medals: [...m.medals, { k: 'career', badge, score, born: nextToastAt(m.medals, now) }] });

/** `bestStreak` is the most kills you have ever made in one life, from this browser's records. */
export function addMoments(m: Moments, prev: Snapshot | null, next: Snapshot, now: number, bestStreak = Infinity): Moments {
  const callouts = m.callouts.filter((c) => now - c.born < CALLOUT_MS);
  const announce = (c: Omit<Callout, 'born'>) => callouts.push({ ...c, born: Math.max(now, (callouts.at(-1)?.born ?? -Infinity) + CALLOUT_STAGGER_MS) });
  const popups = m.popups.filter((p) => now - p.born < POPUP_MS);
  const me = selfOf(next);
  // The report card holds the screen once the core falls.
  const medals = m.medals.filter((t) => now - t.born < (t.k === 'career' ? CAREER_TOAST_MS : MEDAL_MS));
  // Bigger medals land first; each one after a short beat, so a Quad Kill and its streak medal each get their moment.
  const earnedNow = next.events.flatMap((ev) => (ev.e === 'medal' && ev.id === next.self.id ? [ev.medal] : []))
    .sort((a, b) => MEDALS[b].score - MEDALS[a].score);
  for (const medal of earnedNow) medals.push({ k: 'medal', medal, born: nextToastAt(medals, now) });
  if ((!me?.alive && !me?.downed) || next.run?.phase === 'over') return { callouts: [], popups, medals, best: false };
  for (const c of runCallouts(prev?.run, next.run, (prev?.tick ?? 0) * TICK_MS, next.tick * TICK_MS, squadShare(next.players))) {
    announce({ title: c.title, line: c.line, color: TONE[c.tone], ring: c.tone !== 'warn' });
  }
  for (const c of royaleCallouts(prev?.royale, next.royale, (prev?.tick ?? 0) * TICK_MS, next.tick * TICK_MS)) announce({ ...c, color: '#c9b3ff', ring: false });
  for (const ev of next.events) {
    if (ev.e === 'life' && ev.id === next.self.id && ev.k === 'revived') {
      const by = next.players.find((p) => p.id === ev.by)?.name;
      announce({ title: 'Back on your feet', line: by ? `${by} got you up` : 'Your squad got you up', color: PALETTE.hpGood, ring: true });
    }
    if (ev.e === 'tower' && ev.by === next.self.id) {
      announce({ title: 'Recon', line: ev.n === 0 ? 'Nobody in range' : `${ev.n} player${ev.n === 1 ? '' : 's'} marked on your map`, color: '#7fd4ff', ring: true });
    }
    if (ev.e === 'zkill' && ev.by === next.self.id) popups.push({ x: ev.x, y: ev.y, amount: ZOMBIES[ev.kind].score, born: now });
  }
  const was = prev && selfOf(prev);
  const life = me?.alive && was?.alive ? { me, was } : null;
  if (life && GUNS[life.me.gun].stage > GUNS[life.was.gun].stage) {
    const gun = GUNS[life.me.gun];
    announce({ title: gun.name, line: `Evolved · ${gun.desc}`, color: gun.look.accent, ring: true });
    if (gun.stage === 2) announce({ title: 'You are HUNTED', line: HUNTED_LINE, color: PALETTE.hunted, ring: false });
  }
  const kills = next.events.filter((ev): ev is KillEvent => ev.e === 'kill' && ev.killerId === next.self.id && ev.victimId !== next.self.id);
  const earned = life ? life.me.score - life.was.score : 0;
  for (const ev of kills) {
    const at = fallOf(prev, next, ev.victimId);
    if (at && earned > 0) popups.push({ ...at, amount: Math.round(earned / kills.length), born: now });
  }
  const streak = next.self.streak;
  let best = streak === 0 ? false : m.best;
  if (!best && streak > bestStreak && bestStreak >= STREAK.showAt) {
    best = true;
    announce({ title: 'NEW BEST', line: `${streak} kills in one life`, color: MOMENT_COLORS.best, ring: true });
  }
  // Bloodlust heals on every hit you land, not only a kill.
  const lifted = kills.length > 0 || (Object.values(next.self.perks).includes('bloodlust') && next.events.some((e) => e.e === 'dmg' && e.attacker === next.self.id && e.kind === 'player'));
  if (lifted && life && life.me.hp - life.was.hp >= 1) {
    popups.push({ x: life.me.x, y: life.me.y, amount: 0, text: `+${Math.round(life.me.hp - life.was.hp)} HP`, color: MOMENT_COLORS.heal, born: now, onSelf: true });
  }
  return { callouts, popups, medals, best };
}

function fallOf(prev: Snapshot | null, next: Snapshot, victim: number): { x: number; y: number } | null {
  const blow = next.events.filter((ev) => ev.e === 'dmg' && ev.kind === 'player' && ev.victim === victim).at(-1);
  if (blow?.e === 'dmg') return { x: blow.x, y: blow.y };
  return prev?.players.find((p) => p.id === victim) ?? null;
}
