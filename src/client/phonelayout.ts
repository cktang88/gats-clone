import { STICK_RADIUS } from './touch.ts';

/**
 * The phone-on-its-side HUD (a touch screen under 520 CSS px tall): where every HUD element goes, as one pure function of the
 * screen, its notch and home-bar insets and the HUD scale, so the canvas HUD (hud.ts), the DOM buttons (phonehud.ts) and the
 * layout test all read the same boxes.
 *
 * The rule: nothing covers the central play area (`safe`, the middle of the screen round your soldier), and no two elements
 * overlap. The corners hold the HUD: vitals and the minimap top left, above the move stick's resting ring; the clock chip and
 * one slim status line top centre; the scoreboard chip, the emote button and the cog top right with the kill feed under them;
 * reload and the ability in a column at the right edge beside the aim stick's ring, with the context button (use, radio) above
 * that ring; and the chat and the bottom line (hints, the level-up pill) low between the two sticks.
 */
export type Box = { x: number; y: number; w: number; h: number };
export type Insets = { l: number; t: number; r: number; b: number };

export type PhoneLayout = {
  /** The central play area: no box below may enter it. */
  safe: Box;
  vitals: Box;
  minimap: Box;
  /** Top centre: the clock or phase chip, and under it one slim line (siege bar, team score, a brief banner). */
  topChip: Box;
  topLine: Box;
  /** Top right: the scoreboard chip (your place and score; a tap opens the board), the emote button and the pause cog. */
  board: Box;
  emote: Box;
  cog: Box;
  feed: Box;
  /** The right thumb's buttons. */
  ability: Box;
  reload: Box;
  context: Box;
  /** Low between the sticks: the chat's last lines, and one line for hints and the level-up pill. */
  chat: Box;
  bottom: Box;
  /** Each stick's resting ring (the guide drawn while no thumb is down). */
  moveStick: Box;
  aimStick: Box;
};

/** Below this CSS height a touch screen is a phone on its side and gets this layout; above it (tablets) the usual HUD. */
export const PHONE_MAX_H = 520;
export const isPhoneLandscape = (w: number, h: number, touch: boolean): boolean => touch && h < PHONE_MAX_H && w > h;

/** The central play area as fractions of the screen. */
export const SAFE = { x: 0.3, y: 0.22, w: 0.4, h: 0.5 } as const;
/** Where the sticks rest, in px in from the bottom corners (hud.ts draws their guides there). */
export const STICK_REST = { moveX: 96, aimX: 130, y: 96 } as const;

const EDGE = 10;
const GAP = 8;

/** `k` is the HUD scale (uiscale.ts; 0.9 on a phone): text-bearing boxes grow with it, the touch targets keep their size. */
export function phoneLayout(w: number, h: number, ins: Insets, k = 0.9): PhoneLayout {
  const u = k / 0.9;
  const L = ins.l + EDGE, R = w - ins.r - EDGE, T = ins.t + EDGE, B = h - ins.b - EDGE;
  const safe: Box = { x: w * SAFE.x, y: h * SAFE.y, w: w * SAFE.w, h: h * SAFE.h };
  const ring = (cx: number, cy: number): Box => ({ x: cx - STICK_RADIUS, y: cy - STICK_RADIUS, w: STICK_RADIUS * 2, h: STICK_RADIUS * 2 });
  const mx = ins.l + STICK_REST.moveX, ax = w - ins.r - STICK_REST.aimX, sy = h - ins.b - STICK_REST.y;
  const moveStick = ring(mx, sy), aimStick = ring(ax, sy);

  const vitals: Box = { x: L, y: T, w: 150 * u, h: 52 * u };
  const mapTop = vitals.y + vitals.h + GAP;
  const mapSize = Math.max(48, Math.min(96 * u, moveStick.y - GAP - mapTop));
  const minimap: Box = { x: L, y: mapTop, w: mapSize, h: mapSize };

  const cog: Box = { x: R - 44, y: T, w: 44, h: 44 };
  const emote: Box = { x: cog.x - GAP - 40, y: T + 2, w: 40, h: 40 };
  const board: Box = { x: emote.x - GAP - 92 * u, y: T, w: 92 * u, h: 30 * u };
  const chipW = Math.min(228 * u, board.x - GAP - (w / 2 - (board.x - GAP - w / 2)));
  const topChip: Box = { x: w / 2 - chipW / 2, y: T, w: chipW, h: 26 * u };
  const lineW = Math.min(300 * u, 2 * Math.min(w / 2 - (vitals.x + vitals.w) - GAP, board.x - GAP - w / 2));
  const topLine: Box = { x: w / 2 - lineW / 2, y: topChip.y + topChip.h + 3, w: lineW, h: 24 * u };

  // The ability at the right edge level with the aim ring's centre, reload above it; the context button above the ring.
  const ability: Box = { x: R - 56, y: Math.min(sy - 28, B - 56), w: 56, h: 56 };
  const reload: Box = { x: R - 52, y: ability.y - GAP - 52, w: 52, h: 52 };
  const context: Box = { x: ax - 36, y: aimStick.y - GAP - 42, w: 72, h: 42 };
  // The kill feed under the top-right row: two lines, or one where the context button leaves room for only one.
  const feedX = Math.max(R - 230 * u, safe.x + safe.w + GAP), feedY = cog.y + cog.h + GAP, feedRow = 22 * u;
  const feed: Box = { x: feedX, y: feedY, w: R - feedX, h: (context.y - GAP - feedY >= 2 * feedRow ? 2 : 1) * feedRow };

  const lo = moveStick.x + moveStick.w + GAP, hi = aimStick.x - GAP;
  const bottom: Box = { x: lo, y: B - 28 * u, w: hi - lo, h: 28 * u };
  // The chat keeps its last two lines, or one where the screen is too short to fit two under the play area.
  const row = 18 * u, room = bottom.y - 4 - (safe.y + safe.h + 2);
  const chatH = (room >= 2 * row ? 2 : 1) * row;
  const chat: Box = { x: lo, y: bottom.y - 4 - chatH, w: Math.min(hi - lo, 340), h: chatH };
  return { safe, vitals, minimap, topChip, topLine, board, emote, cog, feed, ability, reload, context, chat, bottom, moveStick, aimStick };
}

export const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const inside = (p: { x: number; y: number }, b: Box): boolean => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
