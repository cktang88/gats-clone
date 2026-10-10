import { onSettings, settings, uiFactor } from './settings.ts';

/**
 * One UI scale for the whole client, from the viewport's shorter CSS side, so the HUD, the in-world labels' plates and the DOM
 * (menu, death card, chat, perks, banners, the profile page) keep the same proportions from a laptop to a 4K monitor.
 *
 * Below `fullAt` the canvas HUD shrinks (never under `min`, or `touchMin` on a touch screen, where smaller text gets hard to
 * read on a phone). From `fullAt` to `growFrom` it draws at 1. Past `growFrom` it grows in step with the short side, so a
 * 1440p or 2160p screen shows the HUD at the same fraction of the screen as a 900px one, up to `max` (2160 / 900).
 */
export const UI_SCALE = { fullAt: 560, min: 0.62, touchMin: 0.9, growFrom: 900, max: 2.4 } as const;

/** The query is made once and its live `matches` read after (it is asked every frame); a swapped `matchMedia` is asked anew. */
let coarseQuery: { of: typeof matchMedia; list: MediaQueryList } | null = null;
const coarse = (): boolean => {
  if (typeof matchMedia !== 'function') return false;
  if (coarseQuery?.of !== matchMedia) coarseQuery = { of: matchMedia, list: matchMedia('(pointer: coarse)') };
  return coarseQuery.list.matches;
};

const autoScaleFor = (w: number, h: number, touch: boolean): number => {
  const short = Math.min(w, h);
  if (short > UI_SCALE.growFrom) return Math.min(UI_SCALE.max, short / UI_SCALE.growFrom);
  return Math.max(touch ? UI_SCALE.touchMin : UI_SCALE.min, Math.min(1, short / UI_SCALE.fullAt));
};

/** The automatic scale times the player's UI scale option (80 to 150%; Auto is 1). */
export const uiScaleFor = (w: number, h: number, touch = coarse()): number => autoScaleFor(w, h, touch) * uiFactor(settings().uiScale);

/** The DOM's share of the scale: it grows with the HUD but never shrinks, since the DOM lays itself out for small screens already. */
export const domScaleFor = (w: number, h: number): number => Math.round(Math.max(1, autoScaleFor(w, h, false)) * uiFactor(settings().uiScale) * 100) / 100;

/** Keeps `--ui` on the root (style.css zooms the menu card and the in-game overlays by it) in step with the window's size. */
export function trackRootScale() {
  if (typeof document === 'undefined') return;
  let shown = '';
  const sync = () => {
    const next = String(domScaleFor(innerWidth, innerHeight));
    if (next === shown) return;
    shown = next;
    document.documentElement.style.setProperty('--ui', next);
  };
  sync();
  addEventListener('resize', sync);
  onSettings((_s, changed) => { if (changed === 'uiScale' || changed === null) sync(); });
}
