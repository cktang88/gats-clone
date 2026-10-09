import type { ClientMsg, Loadout } from '../shared/protocol.ts';
import { isPhoneLandscape, phoneLayout, type Box, type Insets } from './phonelayout.ts';
import type { Recap } from './records.ts';

/**
 * The death card's flow, as plain data so main.ts, overlays.ts and the tests share one answer.
 *
 * On a phone on its side screen space is scarce, so the card goes in steps and shows only what matters: first `stats` (who
 * killed you and with what, one line of the life's most notable number, a small More for the rest, and one Try again button),
 * then `loadout` (weapon, color and armor in three lean rows, with Respawn always in view under them). Respawn waits out the
 * timer with the seconds left on the button. Anywhere else the card has room for `all` of it at once: the recap, the loadout
 * and Respawn, which Space also presses. A zombies run has no respawn button (dawn or the Bastion brings you back), and Last
 * Squad shows its result card instead of this one.
 */
export type DeathStep = 'stats' | 'loadout' | 'all';
export type DeathAct = 'loadout' | 'stats' | 'respawn' | 'more';
export type DeathCtx = {
  /** A phone on its side (phonelayout.ts `isPhoneLandscape`): the stepped card. */
  compact: boolean;
  /** Out for the night in a zombies run: no loadout, no respawn button. */
  run: boolean;
  /** Whole seconds left on the respawn timer. */
  wait: number;
};
export type DeathButton = { label: string; act: DeathAct; disabled: boolean };
export type DeathView = {
  step: DeathStep;
  /** The killer's name and gun. */
  title: boolean;
  /** The one-line gist (compact) or the full recap (otherwise). */
  gist: boolean;
  recap: boolean;
  /** Compact only: the More toggle, and whether what it hides (tiles, records, nemesis, lost level, enlist) is open. */
  more: boolean;
  moreOpen: boolean;
  /** The sentence under the recap (timer and hints); the button carries the countdown on a phone. */
  sub: boolean;
  loadout: boolean;
  primary: DeathButton | null;
  secondary: DeathButton | null;
};

/** Where a fresh death card opens. */
export const firstStep = (compact: boolean): DeathStep => (compact ? 'stats' : 'all');

/** A step left over from a different screen (a phone turned, a window resized) maps onto this one. */
export const stepFor = (step: DeathStep, compact: boolean): DeathStep => (!compact ? 'all' : step === 'all' ? 'stats' : step);

const respawnButton = (wait: number): DeathButton => ({ label: wait > 0 ? `Respawn in ${wait}` : 'Respawn', act: 'respawn', disabled: wait > 0 });

export function deathView(step: DeathStep, ctx: DeathCtx, moreOpen: boolean): DeathView {
  const s = stepFor(step, ctx.compact);
  if (ctx.run) {
    return { step: s, title: true, gist: false, recap: false, more: false, moreOpen: false, sub: true, loadout: false, primary: null, secondary: null };
  }
  if (s === 'all') {
    return { step: s, title: true, gist: false, recap: true, more: false, moreOpen: false, sub: true, loadout: true, primary: respawnButton(ctx.wait), secondary: null };
  }
  if (s === 'stats') {
    return {
      step: s, title: true, gist: !moreOpen, recap: moreOpen, more: true, moreOpen, sub: false, loadout: false,
      primary: { label: 'Try again', act: 'loadout', disabled: false }, secondary: null,
    };
  }
  return {
    step: s, title: false, gist: false, recap: false, more: false, moreOpen: false, sub: false, loadout: true,
    primary: respawnButton(ctx.wait), secondary: { label: 'Stats', act: 'stats', disabled: false },
  };
}

/** What pressing a button does: the next step, whether More is open, and the message to send (a respawn with the loadout picked). */
export function deathAct(step: DeathStep, act: DeathAct, ctx: DeathCtx, loadout: Loadout, moreOpen: boolean): { step: DeathStep; moreOpen: boolean; send: ClientMsg | null } {
  const s = stepFor(step, ctx.compact);
  if (act === 'more') return { step: s, moreOpen: !moreOpen, send: null };
  if (act === 'respawn') return { step: s, moreOpen, send: ctx.run || ctx.wait > 0 ? null : { t: 'respawn', loadout: { ...loadout } } };
  if (ctx.run || !ctx.compact) return { step: s, moreOpen, send: null };
  return { step: act, moreOpen: false, send: null };
}

/** Space on the death card: respawns with the same loadout once the timer is up (never in a zombies run). */
export const quickRespawn = (ctx: DeathCtx, loadout: Loadout): ClientMsg | null =>
  ctx.run || ctx.wait > 0 ? null : { t: 'respawn', loadout: { ...loadout } };

/** The life's single most notable line for the compact card: the first record it set, else kills, damage and time alive. */
export function deathGist(recap: Recap | null): string {
  if (!recap) return '';
  const best = recap.stats.find((s) => s.best);
  if (best) return `New best · ${best.value} ${best.label.toLowerCase()}${recap.newBests > 1 ? ` (+${recap.newBests - 1} more)` : ''}`;
  const [kills, damage, , alive] = recap.stats;
  return [kills && `${kills.value} ${kills.value === '1' ? 'kill' : 'kills'}`, damage && `${damage.value} dmg`, alive && alive.value].filter(Boolean).join(' · ');
}

/** The in-match touch controls (reload, ability, GG, radio, the sticks) only while you are alive and playing. */
export const touchControlsShown = (phase: 'menu' | 'playing' | 'dead' | 'reconnecting'): boolean => phase === 'playing';

/**
 * Where the compact card may go: the whole visible screen inside the notch and home-bar insets, less a margin, and clear of the
 * pause cog's column top right (it stays tappable while you are dead). The card is a column whose last row (the buttons) never
 * scrolls, so the bottom `footH` of this box is always on screen.
 */
export const DEATH_FOOT_H = 52;
const MARGIN = 8;

export function deathBox(w: number, h: number, ins: Insets, k = 0.9): Box {
  const cog = phoneLayout(w, h, ins, k).cog;
  const L = ins.l + MARGIN, R = w - ins.r - MARGIN, T = ins.t + MARGIN, B = h - ins.b - MARGIN;
  // Centred on the screen, as wide as it can be without reaching the cog's column (or 640 px, past which lines get long).
  const half = Math.min(320, w / 2 - L, cog.x - MARGIN - w / 2);
  return { x: w / 2 - half, y: T, w: 2 * half, h: B - T };
}

/** The primary button's box when the card fills its box: the right end of the footer row. */
export function deathPrimaryBox(card: Box): Box {
  const pad = 10, bw = Math.min(260, card.w * 0.55);
  return { x: card.x + card.w - pad - bw, y: card.y + card.h - pad - (DEATH_FOOT_H - 8), w: bw, h: DEATH_FOOT_H - 8 };
}

export const compactDeath = (w: number, h: number, touch: boolean): boolean => isPhoneLandscape(w, h, touch);
