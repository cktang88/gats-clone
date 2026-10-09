import { knobs } from './quality.ts';
import { canFullscreen } from './fullscreen.ts';
/** Everything about the physical screen: its size (as the browser really shows it) and the notch and home-bar insets. */

export type Insets = { l: number; t: number; r: number; b: number };
export const NO_INSETS: Insets = { l: 0, t: 0, r: 0, b: 0 };
export type Layout = { w: number; h: number; dpr: number; safe: Insets };

const MAX_DPR = 2.5;

let probe: HTMLElement | null = null;
/** Reads env(safe-area-inset-*) by letting the browser resolve it as padding on a hidden element. */
export function readSafeInsets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => Math.max(0, parseFloat(v) || 0);
  return { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
}

/** The visible area. iOS Safari's toolbars move, and visualViewport tracks them where innerHeight can lag. */
export function measureLayout(): Layout {
  const vv = window.visualViewport;
  const w = Math.round(vv && vv.scale === 1 ? vv.width : window.innerWidth);
  const h = Math.round(vv && vv.scale === 1 ? vv.height : window.innerHeight);
  return { w, h, dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR, knobs().dprCap), safe: readSafeInsets() };
}

export const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = (): boolean => (navigator as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;

/** Stops pinch zoom, double-tap zoom and rubber-band scrolling on the play surface (iOS ignores user-scalable=no). */
export function installTouchGuards(surface: HTMLElement): void {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  const stop = (e: TouchEvent) => { if (e.cancelable && (e.target === surface || e.touches.length > 1)) e.preventDefault(); };
  document.addEventListener('touchmove', stop, { passive: false });
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = e.timeStamp;
    if (now - lastEnd < 350 && e.target === surface && e.cancelable) e.preventDefault();
    lastEnd = now;
  }, { passive: false });
}

const HINT_KEY = 'skirmish.a2hsHint';
/**
 * The menu's full-screen tip, for an iPhone in Safari: it has no page fullscreen, so only the home-screen app hides Safari's bars.
 * An iPad (and Android) can go fullscreen in the browser (fullscreen.ts), so it gets no tip; nor does the installed app.
 */
export function shouldShowHomeScreenHint(): boolean {
  if (!isIos() || isStandalone() || !window.matchMedia('(pointer: coarse)').matches || canFullscreen(document, document.documentElement)) return false;
  try { return localStorage.getItem(HINT_KEY) === null; } catch { return false; }
}
export function dismissHomeScreenHint(): void {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode: the hint just shows again */ }
}
