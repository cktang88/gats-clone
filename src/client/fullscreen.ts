/**
 * Fullscreen on a touch screen. Where the page can go fullscreen (Android Chrome, iPad Safari, a touch laptop), the first tap in
 * each match asks for it, inside that tap's user gesture, which is the only time a browser allows it, and locks the screen to
 * landscape where the browser lets a page do that. Play asks too (main.ts), but a match can begin without Play (the range
 * card, an invite link, a reconnect), and a player may have left fullscreen since.
 *
 * Once per match: a player who leaves fullscreen mid-match (the back gesture, Esc) is not pulled back in until the next match,
 * and a browser that refuses is not asked again until then either.
 *
 * An iPhone has no page fullscreen at all (Safari gives it to video only), so there `request` finds nothing to call and the
 * home-screen app is the way to lose Safari's bars (manifest.webmanifest, index.html and the menu's tip, viewport.ts).
 */
type FsDoc = { fullscreenElement?: unknown; webkitFullscreenElement?: unknown; fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean };
type FsRoot = { requestFullscreen?: (o?: FullscreenOptions) => Promise<void>; webkitRequestFullscreen?: () => void };

export const isFullscreen = (doc: FsDoc): boolean => !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);

/** Whether this page can ask for fullscreen at all (false on an iPhone, and where a frame or policy forbids it). */
export const canFullscreen = (doc: FsDoc, root: FsRoot): boolean =>
  (typeof root.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) || (typeof root.webkitRequestFullscreen === 'function' && doc.webkitFullscreenEnabled !== false);

/** Asks for fullscreen (the prefixed call on older iPadOS), then the landscape lock; resolves true once fullscreen. */
export async function requestFullscreen(doc: FsDoc, root: FsRoot, lock?: () => Promise<unknown> | void): Promise<boolean> {
  try {
    if (typeof root.requestFullscreen === 'function') await root.requestFullscreen({ navigationUI: 'hide' });
    else if (typeof root.webkitRequestFullscreen === 'function') root.webkitRequestFullscreen();
    else return false;
  } catch { return false; }
  try { await lock?.(); } catch { /* a lock is a nicety: most browsers allow it only in fullscreen, some never */ }
  return isFullscreen(doc) || typeof root.requestFullscreen !== 'function';
}

export function createAutoFullscreen(doc: FsDoc, root: FsRoot, opts: { touch: () => boolean; lock?: () => Promise<unknown> | void }) {
  let armed = false;
  return {
    /** A match began: its first tap may ask. */
    matchStarted() { armed = true; },
    /** Left the match (to the menu): nothing to ask for until the next one. */
    matchEnded() { armed = false; },
    /** A tap in the match, inside its gesture. Returns true when it asked for fullscreen. */
    tap(): boolean {
      if (!armed) return false;
      armed = false;
      if (!opts.touch() || isFullscreen(doc) || !canFullscreen(doc, root)) return false;
      void requestFullscreen(doc, root, opts.lock);
      return true;
    },
    armed: () => armed,
  };
}
