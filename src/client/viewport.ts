/** Everything about the physical screen: its size, notch insets, and how big the HUD should be on it. */

export type Insets = { l: number; t: number; r: number; b: number };
export const NO_INSETS: Insets = { l: 0, t: 0, r: 0, b: 0 };
export type Layout = { w: number; h: number; dpr: number; ui: number; safe: Insets; phone: boolean; portraitPhone: boolean };

/** A phone's short side tops out around 430 CSS px, a small tablet's is 600+. */
const PHONE_SHORT_SIDE = 600;
const MAX_DPR = 2.5;

/**
 * HUD scale. A phone held in landscape is ~375-430 px tall, where the desktop HUD's 10-11 px type and 20 px rows are unreadable and
 * unhittable, so it grows with the short side (about 1.3x on an iPhone 15 Pro) which lifts the smallest type above 12 CSS px.
 * Tablets get a mild bump; mouse-and-keyboard screens are never scaled, so the desktop look stays as it was.
 */
export function uiScale(w: number, h: number, coarse: boolean): number {
  if (!coarse) return 1;
  const short = Math.min(w, h);
  if (short < PHONE_SHORT_SIDE) return Math.min(1.4, Math.max(1.25, short / 300));
  return short < 900 ? 1.15 : 1;
}

export const isPhone = (w: number, h: number, coarse: boolean): boolean => coarse && Math.min(w, h) < PHONE_SHORT_SIDE;
/** Held upright a phone shows only a narrow strip of the (width-bound) view, so the game asks for a turn instead of being unfairly cramped. */
export const isPortraitPhone = (w: number, h: number, coarse: boolean): boolean => isPhone(w, h, coarse) && h > w;

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
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  return { w, h, dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR), ui: uiScale(w, h, coarse), safe: readSafeInsets(), phone: isPhone(w, h, coarse), portraitPhone: isPortraitPhone(w, h, coarse) };
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

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** The Fullscreen API exists on Android and desktop but not on iPhone Safari, where "Add to Home Screen" is the way in. */
export const fullscreenSupported = (): boolean => {
  const d = document as FullscreenDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) && !isIos();
};
export const inFullscreen = (): boolean => !!(document.fullscreenElement || (document as FullscreenDoc).webkitFullscreenElement);

/** Must run inside a user gesture. Also asks for landscape where the browser lets a fullscreen page lock it. */
export async function goFullscreen(): Promise<void> {
  if (!fullscreenSupported() || inFullscreen()) return;
  const el = document.documentElement as FullscreenEl;
  try {
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.());
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch { /* refused or unsupported: the page still fills the screen it has */ }
}

const HINT_KEY = 'skirmish.a2hsHint';
/** One-time nudge for iOS Safari players: only the home-screen app can hide Safari's toolbars. */
export function shouldShowHomeScreenHint(): boolean {
  if (!isIos() || isStandalone() || !window.matchMedia('(pointer: coarse)').matches) return false;
  try { return localStorage.getItem(HINT_KEY) === null; } catch { return false; }
}
export function dismissHomeScreenHint(): void {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode: the hint just shows again */ }
}
