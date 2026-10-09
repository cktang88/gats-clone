import { GUNS, type GunId, type WeaponId } from './defs.ts';

/**
 * Aim look-ahead: the camera leans a little toward where you aim, so you see more of the side you are looking at.
 *
 * The client's camera follows `you + offset`, the offset pointing exactly along your aim angle (the angle the server already has from your
 * inputs) and as long as `reach` times how far the cursor (or the aim stick) is pushed from the middle of the screen, shortened (never turned)
 * so your own soldier stays well inside the screen. The server widens each
 * player's snapshot interest rectangle on the aimed side by the same reach (`lookSides`), held open while the client's camera eases back
 * (`holdLook`), so the leaned camera never shows ground the server culled, and an enemy only the lean reveals is still sent.
 */
export const LOOK_AHEAD = {
  /**
   * The reach as a share of the view radius (the view's half width), by gun class: a scope wants to see far, a close gun the room around it.
   * 1.4 times the previous lean (pistol 0.32, SMG 0.28, shotgun 0.26, assault 0.36, LMG 0.34, sniper 0.5), itself about two and a half times
   * the first port's, taken with the view zoomed in to 700: aimed at the screen's edge, an assault rifle shows 350 px more ground that way
   * (1050 in all, about what it saw at 780 with the old lean) and a scoped sniper about 630 (1520 in all, a little more than before).
   */
  share: { pistol: 0.45, smg: 0.39, shotgun: 0.36, assault: 0.5, sniper: 0.7, lmg: 0.48 } satisfies Record<WeaponId, number>,
  /**
   * A gun that reaches past the view's edge leans further, far enough that its full lean shows its whole range down the aim (so nobody
   * shoots what they cannot see), but never past this share of the view radius.
   */
  maxShare: 0.75,
  /**
   * However far a gun would lean, your own soldier stays inside this share of the visible half width and half height (an ellipse round the
   * middle of the screen, `boundLean` in client/camera.ts): at least 15% of the screen from any edge, on any shape of screen. It was a fifth
   * (0.6), which cut a scoped sniper's lean down the long side of a 16:9 screen short of its 0.7 share; 0.7 lets it lean in full there.
   */
  edge: 0.7,
  /**
   * A thumb on the aim stick leans this share of a mouse's reach, and keeps the soldier inside `touchEdge`: the stick is pushed far
   * whenever it fires, a phone's screen is small and the sticks sit at its bottom corners.
   */
  touch: 0.7,
  touchEdge: 0.5,
  /** How sharply the lean grows with the cursor's distance from the middle: past 1 a cursor near the middle barely moves the view. */
  ease: 1.2,
  /** The cursor reaches the full lean at this share of the way from the middle to the screen's edge (measured per axis, so on any shape). */
  fullAt: 0.8,
  /** Exponential follow rates (per second): calm, and while the trigger is held or the gun is planted (the view keeps up with a fight). */
  rate: 5,
  aimRate: 8,
  /** An eye that moves further than this between frames (a respawn, a teleport, a map change) snaps the lean instead of easing it. */
  snapPx: 600,
} as const;

/** The full lean in world px for a gun and the view radius it sees by: its class's share, or enough to show its range, up to `maxShare`. */
export const lookReach = (viewRadius: number, gun: GunId): number =>
  Math.max(0, Math.min(viewRadius * LOOK_AHEAD.maxShare, Math.max(viewRadius * LOOK_AHEAD.share[GUNS[gun].base], GUNS[gun].range - viewRadius)));

/** Extra world px past each edge of the view: left, right, up (smaller y), down. */
export type LookSides = { l: number; r: number; u: number; d: number };
export const NO_LOOK: LookSides = { l: 0, r: 0, u: 0, d: 0 };

/** The widening that covers a full lean along `angle`: the bounding box of the centred view and the view moved by the lean. */
export function lookSides(angle: number, reach: number): LookSides {
  if (!(reach > 0) || !Number.isFinite(angle)) return NO_LOOK;
  const x = Math.cos(angle) * reach, y = Math.sin(angle) * reach;
  return { l: Math.max(0, -x), r: Math.max(0, x), u: Math.max(0, -y), d: Math.max(0, y) };
}

/**
 * The widening held open while a client's camera eases away from an old lean: each side decays no faster than the camera's slowest
 * follow (`LOOK_AHEAD.rate`), so it always covers where the camera still is, and never drops below what the current aim wants.
 */
export function holdLook(prev: LookSides | null, want: LookSides, dtMs: number): LookSides {
  if (!prev) return want;
  const k = Math.exp((-LOOK_AHEAD.rate * Math.max(0, dtMs)) / 1000);
  const side = (a: number, b: number) => { const v = Math.max(a, b * k); return v < 0.5 ? 0 : v; };
  return { l: side(want.l, prev.l), r: side(want.r, prev.r), u: side(want.u, prev.u), d: side(want.d, prev.d) };
}
