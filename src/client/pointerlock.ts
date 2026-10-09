import { clampToView, NO_CAL, noteUnits, stepCursor, unitOf, type Point, type UnitCal } from './virtualcursor.ts';

/**
 * Desktop mouse capture. In a match the first click into the game canvas asks the browser for pointer lock, so the cursor can no
 * longer leave the tab: the OS cursor hides, and our own cursor (virtualcursor.ts) follows `movementX`/`movementY`, sliding along
 * the screen's edges and into its corners, and the game draws its crosshair there. Aim, the look-ahead camera and prediction all
 * read the same `mouse` point main.ts keeps, so they work off the captured cursor unchanged.
 *
 * - The click that takes the lock also fires: today's click fires, so nothing is lost or changed, and the cursor starts where the
 *   click was, so that shot goes exactly where the player aimed.
 * - Esc: the browser lets go of the lock itself (the page often never sees the key). A release we did not ask for, with the tab
 *   still focused, is the player's Esc, so `onUserExit` opens the pause menu; a lost focus (alt-tab) only drops the lock.
 * - Anything that needs a real cursor (the pause menu, the chat line, the range panel, the death card, the menu, reconnecting)
 *   makes `want()` false and the lock is let go at once (or never taken). When it is wanted again, the lock comes back by itself
 *   if we were the ones who let it go or the player has just clicked (Resume); otherwise the next click into the game takes it.
 * - While locked, a click lands where our cursor is: on the canvas it fires as usual; over a DOM control (a perk tile, the cog)
 *   it is handed to that control instead.
 * - Every refusal is quiet: no API, a sandboxed iframe, a request too soon after the player's own exit (browsers wait about a
 *   second; one retry is scheduled while the click still counts), Safari answering with neither event. Aim keeps working off
 *   the real cursor exactly as before, and after three refusals that are not that cool-down the page stops asking.
 * - Touch screens never ask.
 *
 * The browser glue is `installPointerLock`; `createPointerLock` takes its environment so the rules are unit-tested in node.
 */

type Listener = (e: Event) => void;
type Target = { addEventListener(type: string, fn: Listener, opts?: boolean | AddEventListenerOptions): void };

export type LockEnv = {
  /** The game canvas: the element locked, and the one a capturing click must land on. */
  target: Target & { requestPointerLock?: () => unknown };
  doc: Target & {
    readonly pointerLockElement: unknown;
    exitPointerLock?: () => void;
    hasFocus(): boolean;
    readonly hidden: boolean;
    elementFromPoint?(x: number, y: number): unknown;
  };
  win: Target;
  now(): number;
  /** Whether the transient user activation of a recent click or key is still live (unknown is treated as live). */
  activation(): boolean | undefined;
  /** A coarse primary pointer: touch screens never capture. */
  coarse(): boolean;
  /** The viewport in CSS px and its device pixel ratio. */
  view(): { w: number; h: number; dpr: number };
  setTimeout(fn: () => void, ms: number): unknown;
  /** Hands a locked click to the DOM control under the cursor. */
  forward(el: unknown, at: Point, button: number): void;
};

export type LockDeps = {
  /** In a match (playing or dead): leaving to the menu forgets that the lock should come back. */
  inMatch(): boolean;
  /** The lock may be held now: playing, nothing open that needs a real cursor. */
  want(): boolean;
  /** Mouse sensitivity while captured (settings). */
  sensitivity(): number;
  /** The aim point, where a re-lock starts our cursor when the real cursor's place is not known yet. */
  origin(): Point;
  /** The player let the lock go (Esc). */
  onUserExit(): void;
};

/** What decides whether the lock may be held: main.ts fills it from the client state each frame. */
export type LockContext = { phase: string; touch: boolean; typing: boolean; paused: boolean; rangeOpen: boolean };

/**
 * The lock may be held only on a desktop, in a live match (not the menu, the death card or a reconnect), with no chat line, pause
 * menu or range panel open: each of those needs a real cursor (or a keyboard) and gets one.
 */
export const lockWanted = (c: LockContext): boolean => !c.touch && c.phase === 'playing' && !c.typing && !c.paused && !c.rangeOpen;

/** Browsers refuse a new lock for about a second after the player's own exit. */
export const LOCK_TIMING = { cooldownMs: 1100, escWindowMs: 300, pendingMs: 1500, maxFailures: 3 } as const;

type MouseLike = { clientX: number; clientY: number; movementX?: number; movementY?: number };
type DownLike = MouseLike & { button: number; target: unknown; isTrusted: boolean; preventDefault(): void; stopImmediatePropagation(): void };

export function createPointerLock(env: LockEnv, deps: LockDeps) {
  const { target, doc } = env;
  let cursor: Point = { x: 0, y: 0 };
  let lockedAt = -Infinity;
  let pending = false;
  let pendingAt = 0;
  /** The pending request came from a click into the game (only those count toward giving up). */
  let pendingFromClick = false;
  /** We called exitPointerLock: the release that follows is ours, not the player's. */
  let ourExit = false;
  let userExitAt = -Infinity;
  /** The lock was held and let go while still in the match: it should come back when it is wanted again. */
  let resume = false;
  /** Resume may ask without a fresh click: we let it go ourselves (the spec lets a page re-lock after its own exit). */
  let resumeFree = false;
  let failures = 0;
  let disabled = typeof target.requestPointerLock !== 'function' || !('pointerLockElement' in doc);
  let retryArmed = false;
  let lastPointer = 'mouse';
  let last: Point | null = null;
  /** Where the real cursor last was (an unlocked move or click), where a re-lock starts our cursor. */
  let real: Point | null = null;
  let cal: UnitCal = NO_CAL;
  let wanted = false;

  const isLocked = () => doc.pointerLockElement === target;
  const origin = (): Point => real ?? deps.origin();
  const unit = () => unitOf(cal, env.view().dpr);

  function request(origin: Point, fromClick: boolean) {
    if (disabled || env.coarse() || isLocked() || !deps.want()) return;
    if (pending && env.now() - pendingAt < LOCK_TIMING.pendingMs) return;
    const v = env.view();
    cursor = clampToView(origin, v.w, v.h);
    pending = true;
    pendingAt = env.now();
    pendingFromClick = fromClick;
    try {
      const r = target.requestPointerLock!.call(target);
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(undefined, refused);
    } catch {
      refused();
    }
  }

  /** A refusal, from the promise, the `pointerlockerror` event or a throw (deduplicated: only a pending request is refused). */
  function refused() {
    if (!pending) return;
    pending = false;
    const counts = pendingFromClick;
    const sinceExit = env.now() - userExitAt;
    if (sinceExit < LOCK_TIMING.cooldownMs + 400) {
      // Too soon after the player's own Esc: ask once more when the wait is over, while the click that asked still counts.
      if (!retryArmed && env.activation() !== false) {
        retryArmed = true;
        env.setTimeout(() => { retryArmed = false; if (deps.want() && !isLocked()) request(origin(), false); }, Math.max(0, LOCK_TIMING.cooldownMs - sinceExit) + 50);
      }
      return;
    }
    if (counts && ++failures >= LOCK_TIMING.maxFailures) disabled = true;
  }

  function onChange() {
    pending = false;
    if (isLocked()) {
      lockedAt = env.now();
      failures = 0;
      resume = false;
      resumeFree = false;
      // Granted after it stopped being wanted (Leave pressed in the same click, say): let it straight go.
      if (!deps.want()) release();
      return;
    }
    const mine = ourExit;
    ourExit = false;
    lockedAt = -Infinity;
    last = null;
    resume = deps.inMatch();
    resumeFree = mine;
    if (mine) return;
    // Not ours. With the tab still in front it was the player's Esc; a lost focus (alt-tab, a notification) only drops it.
    if (!doc.hasFocus() || doc.hidden) return;
    userExitAt = env.now();
    deps.onUserExit();
  }

  function release() {
    if (!isLocked()) return;
    ourExit = true;
    try { doc.exitPointerLock?.(); } catch { ourExit = false; }
  }

  /** Called every frame: let go when the lock is no longer wanted, and take it back when it is wanted again. */
  function sync() {
    if (!deps.inMatch()) { resume = false; resumeFree = false; }
    const want = deps.want();
    if (isLocked() && !want) release();
    else if (want && !wanted && resume && resumeFree) request(origin(), false);
    wanted = want;
  }

  /** A click just closed what held the lock off (the pause menu's Resume): take it back while that click still counts. */
  function resumeNow() {
    // Closed by a key with no recent click (Esc does not count as one): a request would only be refused, so wait for the click.
    if (resume && deps.want() && (resumeFree || env.activation() !== false)) request(origin(), false);
  }

  /** A mouse move: the aim point. Locked, our cursor moved by the motion; free, the real cursor (which also teaches the unit). */
  function move(e: MouseLike): Point {
    if (isLocked()) {
      const v = env.view();
      cursor = stepCursor(cursor, e.movementX ?? 0, e.movementY ?? 0, { w: v.w, h: v.h, sensitivity: deps.sensitivity(), unit: unit(), sinceLockMs: env.now() - lockedAt });
      return cursor;
    }
    const at = { x: e.clientX, y: e.clientY };
    if (last && e.movementX !== undefined && e.movementY !== undefined) cal = noteUnits(cal, at.x - last.x, at.y - last.y, e.movementX, e.movementY);
    last = real = at;
    return at;
  }

  function onDown(e: DownLike) {
    if (!e.isTrusted) return;
    if (isLocked()) {
      const hit = doc.elementFromPoint?.(cursor.x, cursor.y);
      if (!hit || hit === target) return;
      // Over a DOM control: the click is its, as it would be with a real cursor there, and the gun does not fire.
      e.stopImmediatePropagation();
      e.preventDefault();
      env.forward(hit, { ...cursor }, e.button);
      return;
    }
    real = { x: e.clientX, y: e.clientY };
    if (e.target !== target || lastPointer !== 'mouse') return;
    request(real, true);
  }

  env.doc.addEventListener('pointerlockchange', onChange);
  env.doc.addEventListener('pointerlockerror', () => refused());
  env.win.addEventListener('pointerdown', ((e: { pointerType?: string }) => { lastPointer = e.pointerType || 'mouse'; }) as unknown as Listener, { capture: true });
  env.win.addEventListener('mousedown', onDown as unknown as Listener, { capture: true });

  return {
    move,
    sync,
    resume: resumeNow,
    release,
    locked: isLocked,
    /** An Escape key that arrives just after the browser dropped the lock for it: the pause menu it opened must stay open. */
    escapeSpent: (now: number) => now - userExitAt < LOCK_TIMING.escWindowMs,
    probe: () => ({ locked: isLocked(), pending, disabled, failures, resume, cursor: { ...cursor }, unit: unit(), userExitAt }),
  };
}

export type PointerLock = ReturnType<typeof createPointerLock>;

/** A locked click handed to the DOM control under our cursor, as the events a real click there would send. */
function forwardClick(el: unknown, at: Point, button: number) {
  if (!(el instanceof Element)) return;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, button, view: window };
  const pointer = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', pointer));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', pointer));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  if (button === 0) el.dispatchEvent(new MouseEvent('click', init));
}

/** The browser glue: the real document and window, and a frame loop that keeps the lock in step with `want()`. */
export function installPointerLock(canvas: HTMLCanvasElement, deps: LockDeps, view: () => { w: number; h: number; dpr: number }): PointerLock {
  const coarse = matchMedia('(pointer: coarse)');
  const lock = createPointerLock({
    target: canvas,
    doc: document,
    win: window,
    now: () => performance.now(),
    activation: () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive,
    coarse: () => coarse.matches,
    view,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    forward: forwardClick,
  }, deps);
  // `?dev`: skirmishDev.pointerLock() reads the state; set each frame, since devprobe.ts replaces the whole object once.
  const dev = new URLSearchParams(location.search).has('dev') ? (window as unknown as { skirmishDev?: { pointerLock?: unknown } }) : null;
  const loop = () => {
    lock.sync();
    if (dev) (dev.skirmishDev ??= {}).pointerLock ??= lock.probe;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return lock;
}
