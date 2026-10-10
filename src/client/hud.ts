import { abilityCooldownMs } from '../shared/sim/stats.ts';
import { raiseWatch, reticleLook } from './raise.ts';
import { SPRINT_RING, STICK_RADIUS, stickVector, sticksSprint, type Sticks } from './touch.ts';
import { ARMOR_IDS, byColor, COLORS, GUN_IDS, GUNS, LEVELS, PERK_INFO, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, type BuildingKind, type ColorId, type GunId, type PendingPick, type PerkId, type Tier } from '../shared/defs.ts';
import { MAP_MS } from '../shared/maps.ts';
import type { PlayerView, Snapshot, Team, ZoneView } from '../shared/protocol.ts';
import { flagOf, zoneLetter, zonesOf } from './zoneart.ts';
import { worldToScreen, type Camera, type Point } from './camera.ts';
import { clearOfRects, clock, edgePoint, boardRows, feedMentions, levelProgress, mapNotice, mostKillsText, objectiveFor, roundTimeLeft, type Rect } from './derive.ts';
import { ASSIST_MS, HITMARKER_MS, HURT_ARC_MS, HURT_MS } from './feedback.ts';
import { serverNow } from './interp.ts';
import { fillIcon, PERK_ICONS, strokeIcon, UI_ICONS } from './icons.ts';
import { CALLOUT_MS, POPUP_MS, RING_MS } from './moments.ts';
import { glow, PALETTE, shade, TEAM_COLORS, tint, ZOMBIE_LOOK } from './palette.ts';
import { nightAmount } from './render.ts';
import { CORE_ALERT_MS } from './siege.ts';
import { BUILD_CONTROLS, buildRows, buildsByNight, downedLine, forecast, phaseLine, readyHint, squadShare, upgradeTarget, useHint, NIGHT_BUILD_HINT, type BuildChip, type HintChip } from './zombies.ts';
import { airdropLine, drawAirdropMap } from './arenafx.ts';
import { drawRingMap, drawTracker, reviveHint, ringLine, ringPill, spectateLines, squadLabel, trackerSize } from './royale.ts';
import { drawGunArt, skinInk } from './gunart.ts';
import type { Session } from './state.ts';
import { uiScaleFor } from './uiscale.ts';
import { crosshairLook } from './settings.ts';
import { inside, isPhoneLandscape, phoneLayout, STICK_REST, type Box, type PhoneLayout } from './phonelayout.ts';
import { loadoutSlots, progressLine, slotBoxes, type LoadoutSlot, type Progress, type SlotBox, type SlotKind } from './loadout.ts';
import { FOCUS, feedKeeps, labelsOn, phoneFocus, type PhoneElement } from './phonefocus.ts';
import { phoneDomState, syncPhoneFocus } from './phonehud.ts';

/** The kit's condensed face (style.css), with the system face standing in until it loads. */
const HUD_FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';
const touchScreen = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/**
 * Text sizes, before the HUD's scale (uiscale.ts). The smallest is 13 px, so on a desktop of 560px or more on its short side
 * (scale 1 and up) no HUD text falls under 13 CSS px; a phone's HUD draws at 0.9, still just under 12.
 */
const TYPE = { micro: 13, label: 14, body: 16, title: 18, figure: 24 } as const;
const SPACE = { sm: 8, md: 12, lg: 16 } as const;
/** The kit's gunmetal plates (style.css): bone ink, grey labels, one orange accent, and a clipped corner instead of a round one. */
const PANEL_FILL = 'rgba(19, 21, 25, 0.86)';
const PANEL_INK = '#ece6d6';
const PANEL_MUTED = '#9a9ea6';
const PANEL_CUT = 7;
const ACCENT = '#ff5a1f';
/** Text on a plate needs no halo; the plate is its ground. */
const ON_PANEL = { ink: PANEL_INK, muted: PANEL_MUTED, track: 'rgba(236, 230, 214, 0.14)', glyph: PANEL_INK, halo: 'rgba(0, 0, 0, 0)' } as const;
const ON_WORLD = {
  day: { ink: '#454953', muted: '#80848e', track: '#9b9fa9', glyph: '#4f535d', halo: 'rgba(230, 229, 232, 0.9)' },
  night: { ink: '#eef1f6', muted: '#b4bccb', track: 'rgba(210, 216, 230, 0.35)', glyph: '#dfe4ee', halo: 'rgba(24, 30, 56, 0.6)' },
} as const;
type OnWorld = { ink: string; muted: string; track: string; glyph: string; halo: string };
const EDGE = 16;
/** Notch and home-bar insets in screen px (set on every resize); `inset()` gives them in HUD units, so each corner panel sits inside them. */
let safe = { l: 0, t: 0, r: 0, b: 0 };
export const setHudInsets = (i: { l: number; t: number; r: number; b: number }): void => { safe = i; };
const inset = () => ({ l: safe.l / hudScale, t: safe.t / hudScale, r: safe.r / hudScale, b: safe.b / hudScale });
const FEED_ROW = 24;
const FEED_MS = 6000;
const TAU = Math.PI * 2;
const HURT_BANDS = 12;
const HURT_EDGE = { depth: 0.06, alpha: 0.05, alphaPerStrength: 0.12 } as const;
/**
 * Suppression closes in on the screen as tunnel vision: a vignette clear for the inner `clear` of the way out, black from `reach`
 * of the way to the corners (so each edge's middle is in full shade too), `alpha` dark at full strength and rising with the
 * server's value to the power `curve` so a burst is felt at once, easing toward it at `ease` per ms. Past `readable` the HUD
 * text takes its night colors so it stays legible over the shade.
 */
const SUPPRESS_EDGE = { clear: 0.16, alpha: 0.96, ease: 0.008, readable: 0.3, reach: 0.82, curve: 0.65 } as const;
let shownSuppression = 0;
let suppressShade: { w: number; h: number; image: HTMLCanvasElement } | null = null;

/** A soft elliptical vignette, baked once per screen size, since a full-screen radial gradient costs milliseconds to rasterize every frame. */
function vignette(w: number, h: number): HTMLCanvasElement {
  if (suppressShade?.w === w && suppressShade.h === h) return suppressShade.image;
  const image = document.createElement('canvas');
  const scale = 0.5;
  image.width = Math.max(1, Math.round(w * scale));
  image.height = Math.max(1, Math.round(h * scale));
  const g = image.getContext('2d')!;
  // Squashed to the screen's shape, so the circle that reaches the corners is the screen's own ellipse.
  const cx = image.width / 2;
  g.translate(cx, image.height / 2);
  g.scale(1, image.height / image.width);
  // Black already at `reach` of the way to the corners, which puts the middle of each edge in full shade: tunnel vision.
  const outer = cx * Math.SQRT2 * SUPPRESS_EDGE.reach;
  const fill = g.createRadialGradient(0, 0, outer * SUPPRESS_EDGE.clear, 0, 0, outer);
  fill.addColorStop(0, 'rgba(6, 7, 10, 0)');
  fill.addColorStop(0.35, 'rgba(6, 7, 10, 0.45)');
  fill.addColorStop(0.7, 'rgba(6, 7, 10, 0.88)');
  fill.addColorStop(1, 'rgba(6, 7, 10, 1)');
  g.fillStyle = fill;
  g.fillRect(-cx, -cx, image.width, image.width);
  suppressShade = { w, h, image };
  return image;
}

/** `P` is the phone layout (phonelayout.ts) in HUD units on a phone on its side, else null. */
type Hud = { ctx: CanvasRenderingContext2D; w: number; h: number; snap: Snapshot; s: Session; me: PlayerView | null; now: number; dt: number; cam: Camera; selfAt: Point; on: OnWorld; P: PhoneLayout | null; F?: Record<PhoneElement, boolean> | null };

const GUN_BY_NAME = new Map<string, GunId>(GUN_IDS.map((id) => [GUNS[id].name, id]));
const PERK_BY_NAME = new Map<string, PerkId>(Object.entries(PERK_INFO).map(([id, info]) => [info.name, id as PerkId]));

/**
 * Where an idle stick's guide ring sits, in px in from its bottom-left (move) or bottom-right (aim) corner, where the touch buttons arc above it (style.css),
 * and how faint it is before and after the player has first used that stick.
 */
const STICK_GUIDE = { inset: 96, aimRight: 150, alpha: 0.24, usedAlpha: 0.1, labelMs: 5000, labelFadeMs: 600 } as const;
const sticksUsed = { move: false, aim: false };
/** When the guides were first drawn this match (a gap in drawing starts a new one): their labels show only for the first few seconds. */
const guideClock = { since: 0, last: -1e9 };
/** Once a phone has shown the stick labels for their full few seconds, it never shows them again (kept on this device). */
const LABELS_KEY = 'skirmish.stickLabels';
const labelsSeen = {
  first: (() => { try { return localStorage.getItem(LABELS_KEY) !== 'seen'; } catch { return true; } })(),
  marked: false,
  mark() { if (this.marked) return; this.marked = true; this.first = false; try { localStorage.setItem(LABELS_KEY, 'seen'); } catch { /* a private window forgets */ } },
};

/** Touch screens draw a faint ring where each stick goes while no thumb is on it, so players know the sticks are there. */
function drawStickGuides(ctx: CanvasRenderingContext2D, sticks: Sticks, w: number, h: number) {
  const now = performance.now();
  if (now - guideClock.last > 2000) guideClock.since = now;
  guideClock.last = now;
  const phone = isPhoneLandscape(w, h, true);
  // On a phone the labels show only in your first match (phonefocus.ts); after their few seconds they never come back.
  if (phone && labelsSeen.first && now - guideClock.since >= STICK_GUIDE.labelMs) labelsSeen.mark();
  const labelAlpha = phone && !labelsOn(labelsSeen.first, now, guideClock.since) ? 0 : Math.max(0, Math.min(1, (STICK_GUIDE.labelMs - (now - guideClock.since)) / STICK_GUIDE.labelFadeMs));
  // On a phone on its side the reload and ability buttons stand in a column at the right edge, so the aim ring rests a little further out.
  const aimRight = phone ? STICK_REST.aimX : STICK_GUIDE.aimRight;
  const guides = [
    { key: 'move', active: sticks.move, x: STICK_GUIDE.inset + safe.l, label: 'MOVE' },
    { key: 'aim', active: sticks.aim, x: w - aimRight - safe.r, label: 'AIM · FIRE' },
  ] as const;
  for (const g of guides) {
    if (g.active) { sticksUsed[g.key] = true; continue; }
    const y = h - STICK_GUIDE.inset - safe.b;
    ctx.globalAlpha = sticksUsed[g.key] ? STICK_GUIDE.usedAlpha : STICK_GUIDE.alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, y, STICK_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(g.x, y, STICK_RADIUS * 0.42, 0, Math.PI * 2);
    ctx.fill();
    if (labelAlpha <= 0) continue;
    ctx.globalAlpha *= labelAlpha;
    ctx.font = '700 15px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.label, g.x, y + STICK_RADIUS + 12);
  }
  ctx.globalAlpha = 1;
}

export function drawSticks(ctx: CanvasRenderingContext2D, sticks: Sticks, dpr: number, w: number, h: number, touchScreen: boolean) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (touchScreen) drawStickGuides(ctx, sticks, w, h);
  for (const st of [sticks.move, sticks.aim]) {
    if (!st) continue;
    const v = stickVector(st);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(st.ox, st.oy, STICK_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(st.ox + v.x * STICK_RADIUS, st.oy + v.y * STICK_RADIUS, STICK_RADIUS * 0.42, 0, Math.PI * 2);
    ctx.fill();
    // A second, outer ring on the move stick sprints; it lights up orange once the thumb is out on it.
    if (st === sticks.move) {
      ctx.globalAlpha = sticksSprint(st) ? 0.95 : 0.3;
      ctx.lineWidth = 3;
      ctx.strokeStyle = sticksSprint(st) ? '#ff5a1f' : '#ffffff';
      ctx.setLineDash(sticksSprint(st) ? [] : [6, 6]);
      ctx.beginPath();
      ctx.arc(st.ox, st.oy, SPRINT_RING, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;
}

/** `spread` is your current aim spread, or null when no reticle should be drawn. */
/** The whole HUD, panels and text alike, draws on a virtual screen 1 / `scale` as large: see UI_SCALE (uiscale.ts). */
let hudScale = 1;
export const hudScaleFor = (w: number, h: number, touch = touchScreen): number => uiScaleFor(w, h, touch);

/** Dev-only (`?dev`, via `skirmishDev.forceVitals`): overlay values on your own snapshot so each vitals state can be captured on demand. */
type ForcedKill = { killer: string; victim: string; weapon: string; ageMs?: number; mine?: 'killer' | 'victim'; bounty?: boolean; knock?: boolean; killerId?: number; victimId?: number };
type ForcedVitals = { self?: Partial<Snapshot['self']>; me?: Partial<PlayerView>; feed?: ForcedKill[] };
let forcedVitals: ForcedVitals | null = null;
export const forceVitals = (f: ForcedVitals | null): void => { forcedVitals = f; };

/** `top`, on a desktop, is the crosshair's own layer above every DOM overlay (cursorlayer.ts): the reticle is drawn there instead. */
export function drawHud(ctx: CanvasRenderingContext2D, dpr: number, screenCam: Camera, snap: Snapshot, s: Session, now: number, screenCrosshair: Point, spread: number | null, fullBoard = false, top?: { hud(k: number): CanvasRenderingContext2D }) {
  if (forcedVitals) {
    const f = forcedVitals;
    snap = { ...snap, self: { ...snap.self, ...f.self }, players: snap.players.map((p) => (p.id === s.myId ? { ...p, ...f.me } : p)) };
    if (f.feed) {
      const lines = f.feed.map((k, i) => ({ e: 'kill' as const, killer: k.killer, victim: k.victim, weapon: k.weapon, killerId: k.mine === 'killer' ? s.myId : k.killerId ?? -10 - i, victimId: k.mine === 'victim' ? s.myId : k.victimId ?? -50 - i, bounty: k.bounty === true, assisters: [], ended: 0, revenge: false, ...(k.knock ? { knock: true as const } : {}), at: now - (k.ageMs ?? 0) }));
      s = { ...s, feed: [...s.feed.filter((x) => now - x.at < FEED_MS), ...lines] };
    }
  }
  snap = { ...snap, zones: zonesOf(snap.zones) };
  hudScale = hudScaleFor(screenCam.w, screenCam.h);
  const k = hudScale;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
  hudFont = '';
  const cam = k === 1 ? screenCam : { ...screenCam, w: screenCam.w / k, h: screenCam.h / k, scale: screenCam.scale / k };
  const crosshair = { x: screenCrosshair.x / k, y: screenCrosshair.y / k };
  const { w, h } = cam;
  const me = snap.players.find((p) => p.id === s.myId) ?? null;
  const on = nightAmount() > 0.5 || shownSuppression > SUPPRESS_EDGE.readable ? ON_WORLD.night : ON_WORLD.day;
  const P = phoneBoxes(screenCam.w, screenCam.h, k);
  const hud: Hud = { ctx, w, h, snap, s, me, now, dt: Math.min(100, Math.max(0, now - lastHudAt)), cam, selfAt: worldToScreen(cam, s.lastSelf), on, P };
  lastHudAt = now;
  rememberPlayers(snap);
  hudCrosshair = crosshair;
  spreadOff = spread === null;
  panels = [];
  buildChips = [];
  const compact = w < 640 || h < 520 || k < 1;
  const F = P ? focusOf(hud) : null;
  hud.F = F;
  boardShown = false;
  drawSuppression(hud);
  drawHurtVignette(hud);
  drawHurtArcs(hud);
  const boardBottom = P && F ? (F.board ? drawBoardChip(hud, P, fullBoard) : P.board.y + P.board.h) : drawLeaderboard(hud, compact, fullBoard);
  drawMinimap(hud, P && F ? (F.minimapOpen ? P.minimapOpen.w : P.minimap.w) - 16 : compact ? 96 : 160);
  const below = P && F ? drawPhoneTop(hud, P, F) : drawPill(hud, compact);
  // On a phone on its side the feed keeps a line or two under the top-right row (hidden while the board is open over it), and
  // only your own lines and the big events, briefly; on another small touch screen the right column is the leaderboard, so a
  // short feed goes top centre under the timer.
  if (P) { if (boardBottom <= P.board.y + P.board.h) drawKillFeed(hud, P.feed.y, Math.max(1, Math.floor(P.feed.h / FEED_ROW + 0.01)), P.feed.x + P.feed.w, P.feed, true); }
  else if (touchScreen && compact) drawKillFeed(hud, below + SPACE.sm, 2, w / 2 + 120);
  else drawKillFeed(hud, boardBottom + SPACE.sm, compact ? 3 : 5);
  ctx.globalAlpha = 1;
  const siegeTop = P ? below : drawObjectiveLine(hud, below, fullBoard);
  if (me?.alive) drawVitals(hud, compact);
  if (snap.run) drawSiege(hud, snap.run, siegeTop, compact);
  if (snap.royale) drawRoyale(hud, snap.royale, siegeTop);
  drawHuntedArrows(hud);
  drawZoneArrows(hud);
  drawScorePopups(hud);
  drawCallouts(hud);
  trackAbility(snap.self, now);
  stepRaise(hud);
  if (spread !== null) drawReticle(top ? { ...hud, ctx: top.hud(k) } : hud, crosshair, spread);
  drawHitmarker(hud, crosshair);
  drawAssist(hud, crosshair);
}

/** Near misses close in a dark shade round the screen's edges, deepest when fully suppressed. */
function drawSuppression({ ctx, w, h, snap, me, dt }: Hud) {
  const target = me?.alive ? snap.self.suppression : 0;
  shownSuppression += (target - shownSuppression) * Math.min(1, dt * SUPPRESS_EDGE.ease);
  if (shownSuppression < 0.01) return;
  // Rises steeply at first, so even a burst of near misses is felt; full suppression all but blinds the edges.
  ctx.globalAlpha = SUPPRESS_EDGE.alpha * shownSuppression ** SUPPRESS_EDGE.curve;
  ctx.drawImage(vignette(w, h), 0, 0, w, h);
  ctx.globalAlpha = 1;
}

/** Stacked translucent edge bands instead of a full-screen radial gradient, which costs several milliseconds to rasterize. */
function drawHurtVignette({ ctx, w, h, s, now }: Hud) {
  const hurt = s.feedback.hurt;
  if (!hurt) return;
  const k = (now - hurt.born) / HURT_MS;
  if (k < 0 || k >= 1) return;
  const depth = Math.min(w, h) * HURT_EDGE.depth;
  const step = depth / HURT_BANDS;
  ctx.fillStyle = 'rgb(200, 40, 40)';
  ctx.globalAlpha = ((HURT_EDGE.alpha + HURT_EDGE.alphaPerStrength * hurt.strength) * (1 - k)) / HURT_BANDS;
  for (let i = 0; i < HURT_BANDS; i++) {
    const d = depth - i * step;
    ctx.fillRect(0, 0, w, d);
    ctx.fillRect(0, h - d, w, d);
    ctx.fillRect(0, d, d, h - d * 2);
    ctx.fillRect(w - d, d, d, h - d * 2);
  }
  ctx.globalAlpha = 1;
}

const EDGE_INSET = 34;
const ARROW_CLEARANCE = 16;

function edgeArrow(ctx: CanvasRenderingContext2D, at: Point, angle: number, scale: number, alpha: number) {
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-8, -12);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-8, 12);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = CEL.ink;
  ctx.stroke();
  ctx.fillStyle = PALETTE.hunted;
  ctx.fill();
  ctx.restore();
}

function drawHuntedArrows({ ctx, w, h, snap, now, cam, selfAt }: Hud) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  for (const m of snap.minimap) {
    if (m.pingAge === null) continue;
    const at = edgePoint(selfAt, worldToScreen(cam, m), w, h, EDGE_INSET);
    if (!at) continue;
    edgeArrow(ctx, clearOfRects(selfAt, at, panels, ARROW_CLEARANCE), at.angle, 1 + 0.12 * pulse, 0.6 + 0.35 * pulse);
  }
  ctx.globalAlpha = 1;
}

const ARC = { radius: 58, half: 0.5 } as const;

function drawHurtArcs({ ctx, s, now, selfAt }: Hud) {
  ctx.lineCap = 'round';
  for (const arc of s.feedback.arcs) {
    const k = (now - arc.born) / HURT_ARC_MS;
    if (k < 0 || k >= 1) continue;
    ctx.globalAlpha = (1 - k * k) * (0.55 + 0.45 * arc.strength);
    // An ink edge keeps the chunky red arc apart from any floor.
    for (const [width, color] of [[8.5, CEL.ink], [4.5, PALETTE.hunted]] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(selfAt.x, selfAt.y, ARC.radius + 6 * k, arc.angle - ARC.half, arc.angle + ARC.half);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawAssist({ ctx, s, now }: Hud, at: Point) {
  const assist = s.feedback.assist;
  if (!assist) return;
  const k = (now - assist.born) / ASSIST_MS;
  if (k < 0 || k >= 1) return;
  ctx.globalAlpha = 1 - k * k;
  outlined(ctx, `+${WORLD.assistScore} assist`, at.x, at.y - 30 - 16 * k, TYPE.body, PALETTE.gold, 800);
  ctx.globalAlpha = 1;
}

function drawScorePopups({ ctx, s, now, cam, selfAt }: Hud) {
  for (const p of s.moments.popups) {
    const k = (now - p.born) / POPUP_MS;
    if (k < 0 || k >= 1) continue;
    const at = p.onSelf ? selfAt : worldToScreen(cam, p);
    ctx.globalAlpha = 1 - k * k * k;
    outlined(ctx, p.text ?? `+${p.amount}`, at.x, at.y - 36 - 44 * k, Math.round(17 + 5 * Math.max(0, 1 - k * 5)), p.color ?? PALETTE.gold, 850);
  }
  ctx.globalAlpha = 1;
}

const CALLOUT_GAP = 70;

function drawCallouts({ ctx, w, h, s, now, selfAt, P }: Hud) {
  let row = 0;
  for (const c of s.moments.callouts) {
    const age = now - c.born;
    if (age < 0 || age >= CALLOUT_MS) continue;
    if (c.ring && age < RING_MS) drawRingBurst(ctx, selfAt, c.color, age);
    // A phone shows the callout briefly in its slim top line (drawPhoneLine) instead of a plate over the fight.
    if (P) continue;
    const pop = 1 + 0.25 * Math.max(0, 1 - age / 160);
    ctx.globalAlpha = Math.min(1, age / 90, (CALLOUT_MS - age) / 450);
    const y = h * 0.24 + row * CALLOUT_GAP;
    drawCalloutPlate(ctx, c, w / 2, y, pop, age);
    row++;
  }
  ctx.globalAlpha = 1;
}

/**
 * A callout is a stamped plate: the title in heavy italic capitals in its colour, the line in bone beneath, on a dark band
 * edged in the title's colour that slides open as it lands.
 */
function drawCalloutPlate(ctx: CanvasRenderingContext2D, c: { title: string; line: string; color: string }, x: number, y: number, pop: number, age: number) {
  const size = Math.round(32 * pop);
  setFont(ctx, 900, size, true);
  const tw = ctx.measureText(c.title).width;
  setFont(ctx, 700, TYPE.body);
  const lw = ctx.measureText(c.line).width;
  const open = Math.min(1, age / 140);
  const pw = (Math.max(tw, lw) + 48) * (0.6 + 0.4 * open), ph = 62;
  const left = x - pw / 2, top = y - 24;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.88;
  plate(ctx, left, top, pw, ph);
  ctx.fillStyle = PANEL_FILL;
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = c.color;
  ctx.fillRect(left, top, pw - PANEL_CUT, 3);
  setFont(ctx, 900, size, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.color;
  ctx.fillText(c.title, x, y);
  text(ctx, c.line, x, y + 24, TYPE.body, PANEL_INK, 'center', 700);
}

function drawRingBurst(ctx: CanvasRenderingContext2D, at: Point, color: string, age: number) {
  for (const lag of [0, 140]) {
    const k = (age - lag) / (RING_MS - lag);
    if (k <= 0 || k >= 1) continue;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 4 * (1 - k) + 1;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 24 + 120 * (1 - (1 - k) ** 3), 0, TAU);
    ctx.stroke();
  }
}

const RETICLE = { minGap: 5, maxGap: 120, tick: 7, ring: 6, ringClearance: 6 } as const;

export const reticleGap = (spread: number, distPx: number): number =>
  Math.min(RETICLE.maxGap, Math.max(RETICLE.minGap, Math.tan(spread) * distPx));


let reticleDrawnGap = 0;

/** The ability chip pulses gold for `readyPulseMs` once the cooldown is over, and shakes red for `deniedMs` after Space is pressed too early. */
const ABILITY_CUE = { readyPulseMs: 900, deniedMs: 450 } as const;
let abilityDeniedAt = -Infinity;
let abilityBackAt = -Infinity;
let abilityWasCooling = false;

/** Space was pressed while the ability was still cooling down. */
export const noteAbilityDenied = (now: number) => { abilityDeniedAt = now; };

function trackAbility(self: SelfView, now: number) {
  const cooling = self.ability !== null && self.abilityReadyIn > 0;
  if (abilityWasCooling && !cooling && self.ability !== null) abilityBackAt = now;
  abilityWasCooling = cooling;
}

const deniedShake = (now: number) => {
  const k = (now - abilityDeniedAt) / ABILITY_CUE.deniedMs;
  return k >= 0 && k < 1 ? Math.sin(k * Math.PI * 6) * 3 * (1 - k) : 0;
};

export const drawnReticleGap = (): number => reticleDrawnGap;

/** The reticle's grey while a bolt is worked. */
const RETICLE_DOWN = '#9aa0aa';

/** Steps your gun's watch (see raise.ts) every frame, reticle or not, for the bolt's grey and its flash once chambered. */
function stepRaise({ s, me }: Hud) {
  raiseWatch.step(me?.alive ? s.firing : null, performance.now());
}

function drawReticle({ ctx, snap, selfAt }: Hud, at: Point, spread: number) {
  const reloading = snap.self.reloading;
  const t = performance.now();
  // The gap is the eased spread the next shot gets: blown wide by a sprint and visibly tightening as the post-sprint bloom settles,
  // never jumping (see `SPREAD_EASE`). While a bolt is worked it greys at its own (bloomed) gap and flashes bright once the round is chambered.
  const spreadGap = Math.max(reloading ? RETICLE.ring + RETICLE.ringClearance : 0, reticleGap(spread, Math.hypot(at.x - selfAt.x, at.y - selfAt.y)));
  const rl = reticleLook(raiseWatch.phase, spreadGap, raiseWatch.sinceReady(t), raiseWatch.sinceDenied(t));
  const gap = rl.gap;
  reticleDrawnGap = gap;
  at = { x: at.x + rl.shake, y: at.y };
  ctx.lineCap = 'round';
  ctx.globalAlpha = rl.alpha;
  // The pause menu's crosshair options: a style and one of a few paints (the default is the classic bone cross).
  const look = crosshairLook();
  const paint = rl.grey ? RETICLE_DOWN : rl.flash > 0 ? mixHex(look.color, '#ffffff', rl.flash) : look.color;
  if (look.style === 'classic' || look.style === 'open') {
    for (const [width, color] of [[3.5, 'rgba(30, 32, 38, 0.75)'], [1.5 + rl.flash, paint]] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(at.x + dx * gap, at.y + dy * gap);
        ctx.lineTo(at.x + dx * (gap + RETICLE.tick), at.y + dy * (gap + RETICLE.tick));
      }
      ctx.stroke();
    }
  } else if (look.style === 'ring') {
    for (const [width, color] of [[4.5, 'rgba(30, 32, 38, 0.75)'], [2 + rl.flash, paint]] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(5, gap + RETICLE.tick * 0.5), 0, TAU);
      ctx.stroke();
    }
  }
  if (look.style !== 'open' && rl.dot > 0.05) {
    // No centre dot while a bolt is worked; it pops in, a size too big for a blink, as the round chambers.
    const half = (look.style === 'classic' ? 1 : 2) * rl.dot;
    ctx.fillStyle = 'rgba(30, 32, 38, 0.75)';
    if (look.style !== 'classic' || rl.dot > 1.05) ctx.fillRect(at.x - half - 1.5, at.y - half - 1.5, half * 2 + 3, half * 2 + 3);
    ctx.fillStyle = paint;
    ctx.fillRect(at.x - half, at.y - half, half * 2, half * 2);
  }
  ctx.globalAlpha = 1;
  if (!reloading || snap.self.sprint === true) return;
  // The reload sweep is the reticle's own ring: an ink groove with a gold fill running round it.
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(28, 31, 38, 0.8)';
  ctx.beginPath();
  ctx.arc(at.x, at.y, RETICLE.ring + 1, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.arc(at.x, at.y, RETICLE.ring + 1, -Math.PI / 2, -Math.PI / 2 + snap.self.reloadFrac * TAU);
  ctx.stroke();
}

function drawHitmarker({ ctx, s, now }: Hud, at: Point) {
  const hm = s.feedback.hitmarker;
  if (!hm) return;
  const k = (now - hm.born) / HITMARKER_MS[hm.kill ? 'kill' : 'hit'];
  if (k < 0 || k >= 1) return;
  const [inner, outer] = hm.kill ? [8, 20] : [5, 10];
  const pop = 1 + (1 - k) * (hm.kill ? 0.45 : 0.25);
  ctx.lineCap = 'round';
  if (hm.kill) {
    // A kill also rings out from the crosshair, so it reads as a different event from a hit even out of the corner of an eye.
    ctx.globalAlpha = (1 - k) * 0.9;
    ctx.lineWidth = 2.5 * (1 - k) + 0.5;
    ctx.strokeStyle = '#ff4d4f';
    ctx.beginPath();
    ctx.arc(at.x, at.y, 14 + 26 * (1 - (1 - k) ** 3), 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1 - k * k;
  for (const [width, color] of [[hm.kill ? 6 : 4, 'rgba(30, 32, 38, 0.55)'], [hm.kill ? 3.5 : 2, hm.kill ? '#ff4d4f' : '#ffffff']] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      ctx.moveTo(at.x + dx * inner * pop, at.y + dy * inner * pop);
      ctx.lineTo(at.x + dx * outer * pop, at.y + dy * outer * pop);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

const MINIMAP = { bg: 'rgba(24, 27, 33, 0.93)', block: '#454a53', built: '#6a7da6' } as const;
const MINIMAP_BUILDING: Record<BuildingKind, string> = { wall: '#c7a383', sentry: '#f5c400', cannon: '#ff6b3d', scatter: '#3fd1b8', mortar: '#b98cff', tesla: '#8fb8ff', depot: '#8a9a5b', post: '#8ff0c4', spikes: '#9aa3b0' };

/** Panels drawn this frame, so edge markers drawn after them can stay clear. */
let panels: Rect[] = [];

/**
 * The kit's plate in the menu's cel-shaded 2.5D (menu.css `.plate`): a lit top face, a darker front lip below it, ink outlines and a hard
 * shadow down and to the right (the key light is top left). Returns the lip's height. A `fill` replaces the two-step face.
 */
const CEL = { ink: '#1c1f26', top: '#4c535f', body: '#343a44', lip: '#22262d', well: '#16181d', shadow: 'rgba(5, 6, 9, 0.55)' } as const;
function celPlate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill?: string): number {
  const lip = h < 40 ? 3 : 5;
  plate(ctx, x + 3, y + 3, w, h + lip);
  ctx.fillStyle = CEL.shadow;
  ctx.fill();
  plate(ctx, x, y, w, h + lip);
  ctx.fillStyle = CEL.lip;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = CEL.ink;
  ctx.stroke();
  plate(ctx, x, y, w, h);
  ctx.fillStyle = fill ?? CEL.body;
  ctx.fill();
  if (!fill) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = CEL.top;
    ctx.fillRect(x, y, w, h < 40 ? 3 : 5);
    ctx.restore();
  }
  ctx.stroke();
  return lip;
}

/** A cel-shaded plate with its top right and bottom left corners clipped; a tall one also gets the kit's orange corner bracket. */
function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill?: string) {
  const lip = celPlate(ctx, x, y, w, h, fill);
  panels.push({ x, y, w, h: h + lip });
  if (h < 60) return;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x + 3, y + 3, 14, 3);
  ctx.fillRect(x + 3, y + 3, 3, 14);
}

function plate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const c = Math.min(PANEL_CUT, h / 3);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.closePath();
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string | CanvasGradient, track: string) {
  ctx.fillStyle = track;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(2, h / 2));
  ctx.fill();
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(h, w * f), h, Math.min(2, h / 2));
  ctx.fill();
}

/** Assigning ctx.font reparses the string every time, so skip the assignment when the HUD's last font is still set. */
let hudFont = '';
let lastHudAt = 0;
const fonts = new Map<number, string>();
function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number, italic = false) {
  const key = (italic ? -1 : 1) * (weight * 1000 + size);
  let font = fonts.get(key);
  if (!font) fonts.set(key, (font = `${italic ? 'italic ' : ''}${weight} ${size}px ${HUD_FONT}`));
  if (font !== hudFont) { ctx.font = font; hudFont = font; }
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', weight = 600) {
  setFont(ctx, weight, size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

function worldText(ctx: CanvasRenderingContext2D, on: OnWorld, s: string, x: number, y: number, size: number, color: string, weight: number) {
  setFont(ctx, weight, size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = on.halo;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function outlined(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight: number, italic = false) {
  setFont(ctx, weight, size, italic);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size / 4.5);
  ctx.strokeStyle = 'rgba(19, 21, 25, 0.9)';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/**
 * A line of text over the world, on its own gunmetal plate with clipped corners, so it reads on the bone floor by day as
 * well as by night. Returns the plate's height.
 */
function platedLine(ctx: CanvasRenderingContext2D, s: string, cx: number, cy: number, size: number, color: string, weight: number, accent: string | null = null): number {
  setFont(ctx, weight, size);
  const pw = ctx.measureText(s).width + size * 1.4, ph = Math.round(size * 1.65);
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.92;
  celPlate(ctx, cx - pw / 2, cy - ph / 2, pw, ph);
  ctx.globalAlpha = alpha;
  panels.push({ x: cx - pw / 2, y: cy - ph / 2, w: pw, h: ph });
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(cx - pw / 2, cy - ph / 2, 3, ph - Math.min(PANEL_CUT, ph / 3));
  }
  text(ctx, s, cx, cy + 1, size, color, 'center', weight);
  return ph;
}

const FEED_ICON_W = 44;

/** Class guns read as their icon; an evolved gun is spelled out in its accent color, since its silhouette is easy to mistake. */
function feedWeapon(ctx: CanvasRenderingContext2D, label: string, skin?: string): { width: number; draw(x: number, y: number): void } {
  const gun = GUN_BY_NAME.get(label);
  if (gun && GUNS[gun].stage === 0) {
    return { width: FEED_ICON_W, draw: (x, y) => drawGunArt(ctx, gun, x, y - 7, FEED_ICON_W - SPACE.sm, 14, { flat: skinInk(skin) ?? PANEL_INK, align: 'left' }) };
  }
  const perk = PERK_BY_NAME.get(label);
  if (perk) return { width: 20, draw: (x, y) => strokeIcon(ctx, PERK_ICONS[perk], x + 8, y, 13, PANEL_INK, 2.2) };
  const [color, weight] = gun ? [glow(GUNS[gun].look.accent, 0.74), 800] : [PANEL_MUTED, 500];
  setFont(ctx, weight, TYPE.label);
  return { width: ctx.measureText(label).width + SPACE.sm, draw: (x, y) => text(ctx, label, x, y, TYPE.label, color, 'left', weight) };
}

const LIFE_LINE = { downed: PALETTE.hunted, revived: PALETTE.hpGood, bledOut: PANEL_MUTED, finished: PALETTE.hunted, redeployed: PALETTE.hpGood } as const;

function lifeLine(f: Extract<Snapshot['events'][number], { e: 'life' }>, by: string | null | undefined): string {
  switch (f.k) {
    case 'downed': return `${f.name} is down`;
    case 'revived': return by ? `${by} revived ${f.name}` : `${f.name} is back up`;
    case 'bledOut': return `${f.name} bled out`;
    case 'finished': return by ? `${by} finished ${f.name}` : `${f.name} fell to the ring`;
    case 'redeployed': return `${f.name} redeployed`;
  }
}

/** `rightEdge` is where each row ends; rows right-align there (the screen's right edge by default). */
function drawKillFeed(hud: Hud, top: number, rows: number, rightEdge?: number, clip?: Box, phone = false) {
  const { ctx, w, now } = hud;
  const life = phone ? FOCUS.feedMs : FEED_MS;
  const teamOf = (id: number) => hud.snap.players.find((p) => p.id === id)?.team ?? hud.snap.leaderboard.find((r) => r.id === id)?.team ?? null;
  // A phone's feed keeps to its box: names are cut short, and anything still too wide is clipped at the box's left edge.
  const s = clip ? { ...hud.s, feed: hud.s.feed.map((f) => (f.e === 'kill' ? { ...f, killer: f.killer && shortName(f.killer), victim: shortName(f.victim) } : f)) } : hud.s;
  if (clip) { ctx.save(); ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
  const lines = s.feed.filter((f) => now - f.at < life && (!phone || feedKeeps(f, s.myId, hud.me?.team ?? null, teamOf))).slice(-rows);
  const right = rightEdge ?? w - EDGE - inset().r;
  const drawRow = (f: (typeof lines)[number], i: number) => {
    const y = top + i * FEED_ROW + 10;
    ctx.globalAlpha = Math.min(1, (life - (now - f.at)) / 600) * 0.95;
    setFont(ctx, 650, TYPE.label + 1);
    if (f.e === 'life') {
      const by = f.by === null ? null : hud.snap.players.find((p) => p.id === f.by)?.name ?? hud.snap.leaderboard.find((r) => r.id === f.by)?.name;
      const [line, color] = [lifeLine(f, by), LIFE_LINE[f.k]];
      const pw = ctx.measureText(line).width + SPACE.md * 2;
      feedRow(ctx, right - pw, y, pw, f.id === s.myId);
      ctx.fillStyle = color;
      ctx.fillRect(right - pw + 4, y - 5, 2, 10);
      text(ctx, line, right - pw + SPACE.md, y, TYPE.label + 1, PANEL_INK, 'left', 650);
      ctx.globalAlpha = 1;
      return;
    }
    if (f.e === 'airdrop') {
      const row = airdropLine(f);
      if (!row) return;
      const pw = ctx.measureText(row.text).width + SPACE.md * 2 + 8;
      feedRow(ctx, right - pw, y, pw, f.k === 'taken');
      ctx.fillStyle = row.color;
      ctx.fillRect(right - pw + 4, y - 5, 4, 10);
      text(ctx, row.text, right - pw + SPACE.md + 6, y, TYPE.label + 1, PANEL_INK, 'left', 650);
      ctx.globalAlpha = 1;
      return;
    }
    if (f.e === 'wiped') {
      const line = `${squadLabel(f.team)} is out · #${f.place}`;
      const pw = ctx.measureText(line).width + SPACE.md * 2 + 8;
      feedRow(ctx, right - pw, y, pw, hud.me?.team === f.team);
      ctx.fillStyle = TEAM_COLORS[f.team];
      ctx.fillRect(right - pw + 6, y - 5, 6, 10);
      text(ctx, line, right - pw + SPACE.md + 8, y, TYPE.label + 1, PANEL_INK, 'left', 650);
      ctx.globalAlpha = 1;
      return;
    }
    if (f.e === 'hunted') {
      const line = `${f.name} is hunted`;
      const pw = ctx.measureText(line).width + 20 + SPACE.md * 2;
      feedRow(ctx, right - pw, y, pw, f.id === s.myId);
      strokeIcon(ctx, UI_ICONS.target, right - pw + SPACE.md + 6, y, 12, PALETTE.hunted, 2.2);
      text(ctx, line, right - pw + SPACE.md + 18, y, TYPE.label + 1, PANEL_INK, 'left', 650);
      ctx.globalAlpha = 1;
      return;
    }
    const kw = f.killer ? ctx.measureText(f.killer).width : 0;
    const vw = ctx.measureText(f.victim).width;
    const weapon = feedWeapon(ctx, f.weapon, hud.snap.players.find((p) => p.id === f.killerId)?.cos?.g);
    const markW = f.bounty ? ctx.measureText(`+${WORLD.bountyScore}`).width + 18 : f.knock ? 16 : 0;
    const HT = 17;
    const pw = (f.killer ? kw + HT + SPACE.sm : 0) + vw + HT + weapon.width + markW + SPACE.md * 2;
    let x = right - pw;
    const mine = feedMentions(f, s.myId);
    feedRow(ctx, x, y, pw, mine);
    x += SPACE.md;
    const rowTeam = (id: number | null): Team => (id === null ? null : hud.snap.leaderboard.find((r) => r.id === id)?.team ?? null);
    const teamsOn = hud.snap.match.mode === 'TDM' || hud.snap.match.mode === 'DOM' || hud.snap.match.mode === 'BR';
    if (f.killer) {
      helmet(ctx, x + 6, y, 6.5, colorHexOf(hud.snap, f.killerId, teamsOn ? rowTeam(f.killerId) : null));
      text(ctx, f.killer, x + HT, y, TYPE.label + 1, f.killerId === s.myId ? PANEL_INK : nameColor(hud, f.killerId), 'left', f.killerId === s.myId ? 800 : 650);
      x += kw + HT + SPACE.sm;
    }
    weapon.draw(x, y);
    x += weapon.width;
    helmet(ctx, x + 6, y, 6.5, colorHexOf(hud.snap, f.victimId, teamsOn ? rowTeam(f.victimId) : null));
    text(ctx, f.victim, x + HT, y, TYPE.label + 1, f.victimId === s.myId ? PANEL_INK : nameColor(hud, f.victimId), 'left', f.victimId === s.myId ? 800 : 650);
    x += vw + HT + SPACE.sm;
    if (f.bounty) {
      // A bounty is a gold star and its pay; a knock is a down arrow.
      starPath(ctx, x + 5, y, 7, 0);
      ctx.fillStyle = CEL.ink;
      ctx.fill();
      starPath(ctx, x + 5, y, 5.4, 0);
      ctx.fillStyle = PALETTE.gold;
      ctx.fill();
      text(ctx, `+${WORLD.bountyScore}`, x + 14, y + 1, TYPE.micro, PALETTE.gold, 'left', 800);
    } else if (f.knock) strokeIcon(ctx, UI_ICONS.down, x + 6, y, 12, PALETTE.hunted, 3);
    ctx.globalAlpha = 1;
  };
  lines.forEach((f, i) => {
    // A new line punches in from the right with a little overshoot; one of yours also flashes.
    const age = now - f.at;
    const slide = REDUCED || age > FEED_IN_MS ? 0 : 1 - easeOutBack(Math.max(0, age) / FEED_IN_MS);
    feedAge = age;
    ctx.translate(slide * 150, 0);
    drawRow(f, i);
    ctx.translate(-slide * 150, 0);
  });
  feedAge = 1e9;
  if (clip) ctx.restore();
}
const shortName = (name: string): string => (name.length > 9 ? `${name.slice(0, 8)}…` : name);

const FEED_IN_MS = 320;
const FEED_FLASH_MS = 620;
let feedAge = 1e9;
const easeOutBack = (t: number): number => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

/** A line you took part in carries an orange edge. */
function feedRow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, mine: boolean) {
  panel(ctx, x, y - 10, w, 20, mine ? '#5a3f31' : undefined);
  if (!mine) return;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x, y - 10, 3, 20);
  const flash = popOf(feedAge, FEED_FLASH_MS);
  if (flash > 0) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * flash * 0.7;
    ctx.fillStyle = '#ffd7b0';
    plate(ctx, x, y - 10, w, 20);
    ctx.fill();
    ctx.globalAlpha = a * flash * 0.5;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x - 4 * flash, y - 10, 3 + 4 * flash, 20);
    ctx.globalAlpha = a;
  }
}

const FEED_TEAM: Record<ColorId, string> = { ...byColor((c) => tint(COLORS[c], 0.55)), red: '#ffb0b2', blue: '#b5c6ff' };

function nameColor({ s, snap, me }: Hud, id: number | null): string {
  if (id === s.myId) return me ? ownColor(snap, me) : PALETTE.gold;
  const team = id === null ? null : snap.leaderboard.find((r) => r.id === id)?.team ?? null;
  return team && !snap.run ? FEED_TEAM[team] : PANEL_INK;
}

const ownColor = (snap: Snapshot, me: PlayerView) => (me.team && !snap.run ? FEED_TEAM[me.team] : tint(COLORS[me.color], 0.55));

const timeLeft = ({ snap, s, now }: Hud) => roundTimeLeft(snap.match, serverNow(s.snaps, now));

/** On a phone the board lists only the top `touchTop` and you, so it ends above the ability button (style.css). */
const BOARD = { w: 196, compactW: 162, row: 26, pad: 10, touchTop: 3 } as const;

let boardYs = new Map<number, number>();
const boardMine = { place: null as number | null, climbAt: -1e9 };

/** Friends: a pink heart beside their name on the board and on the minimap, where they always show. */
export const FRIEND_COLOR = '#ff7eb6';
/** An enemy radar's tag, on the minimap and on your own warning. */
const RADAR_TAG = '#7fd4ff';
let friendIds: ReadonlySet<number> = new Set();
/** Your friends in this match (the server's `friends` message). */
export const setHudFriends = (ids: ReadonlySet<number>) => { friendIds = ids; };

/** The board's names as last drawn (HUD units), so a click on one can open its menu; the one under the cursor is underlined. */
/** `right` is the board's left edge, where its menu opens beside it. */
type BoardName = { id: number; name: string; human: boolean; x: number; y: number; w: number; h: number; right: number };
let boardNames: BoardName[] = [];
let boardHover: number | null = null;
export const setBoardHover = (id: number | null) => { boardHover = id; };

/** Dev probe: the board's clickable names as last drawn, in CSS px. */
export const drawnBoardNames = () => boardNames.map((n) => ({ id: n.id, name: n.name, human: n.human, x: n.x * hudScale, y: n.y * hudScale, w: n.w * hudScale, h: n.h * hudScale }));

/** The board name under (sx, sy) CSS px, with its box in CSS px; never your own row. Only the desktop board is clickable. */
export function boardNameAt(sx: number, sy: number): (BoardName & { right: number }) | null {
  if (touchScreen) return null;
  const x = sx / hudScale, y = sy / hudScale;
  const hit = boardNames.find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);
  return hit ? { ...hit, x: hit.x * hudScale, y: hit.y * hudScale, w: hit.w * hudScale, h: hit.h * hudScale, right: hit.right * hudScale } : null;
}

function drawLeaderboard(hud: Hud, compact: boolean, full: boolean, at?: { right: number; top: number; rows: number }): number {
  const { ctx, w, h, snap, s, me } = hud;
  const rows = boardRows(snap.leaderboard, s.myId, full ? at?.rows ?? (compact || h < 760 ? 6 : 12) : null, touchScreen && compact ? BOARD.touchTop : undefined);
  const teams = snap.match.mode === 'TDM' || snap.match.mode === 'DOM' || snap.match.mode === 'BR';
  const ffaTarget = snap.match.mode === 'FFA' ? WORLD.ffaWinKills : 0;
  const pw = compact ? BOARD.compactW : BOARD.w;
  const x = at ? at.right - pw : w - pw - EDGE - inset().r, top = at ? at.top : EDGE + inset().t;
  const split = rows.length > 1 && rows.at(-1)!.place - rows.at(-2)!.place > 1;
  const head = full ? 22 : 0;
  const ph = BOARD.pad * 2 + rows.length * BOARD.row + head + (split ? 5 : 0);
  fadePanel(hud, 'board', x, top, pw, ph);
  panel(ctx, x, top, pw, ph);
  let y = top + BOARD.pad + BOARD.row / 2;
  if (full) {
    const line = snap.run || snap.royale ? 'Squad kills' : teams ? `First to ${snap.match.mode === 'TDM' ? WORLD.tdmWinScore : WORLD.domWinScore}` : mostKillsText(timeLeft(hud));
    text(ctx, line[0]!.toUpperCase() + line.slice(1), x + BOARD.pad + 2, y - 2, TYPE.micro, PANEL_MUTED, 'left', 600);
    y += head;
  }
  const myPlace = rows.find((r) => r.row.id === s.myId)?.place ?? null;
  if (myPlace !== null && boardMine.place !== null && myPlace < boardMine.place) boardMine.climbAt = hud.now;
  boardMine.place = myPlace;
  const rowYs = new Map<number, number>();
  const names: BoardName[] = [];
  rows.forEach(({ place, row: r }, i) => {
    if (split && i === rows.length - 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(x + BOARD.pad, y - BOARD.row / 2, pw - BOARD.pad * 2, 1);
      y += 5;
    }
    const mine = r.id === s.myId;
    const color = PANEL_INK;
    const weight = mine ? 800 : 650;
    // Rows glide to their slot when the order changes; yours is a ribbon that flares when you climb.
    const slotY = y;
    const from = boardYs.get(r.id) ?? slotY;
    const rowY = REDUCED ? slotY : Math.abs(slotY - from) < 0.4 ? slotY : from + (slotY - from) * (1 - Math.exp(-hud.dt / 70));
    rowYs.set(r.id, rowY);
    y = rowY;
    const hex = colorHexOf(snap, r.id, teams ? r.team : null);
    if (mine) {
      const climb = popOf(hud.now - boardMine.climbAt, 900);
      ribbon(ctx, x - 7, y - BOARD.row / 2 + 1, pw + 10, BOARD.row - 2, mixHex(CEL.body, hex, 0.45 + 0.4 * climb));
    }
    text(ctx, String(place), x + BOARD.pad + 2, y, TYPE.label, mine ? PANEL_INK : PANEL_MUTED, 'left', 750);
    helmet(ctx, x + BOARD.pad + 26, y - 1, 8, hex);
    const nx = x + BOARD.pad + 40;
    const flags = seenFlags.get(r.id);
    const friend = friendIds.has(r.id);
    const icons = (flags?.hunted ? 1 : 0) + (flags && flags.streak >= 2 ? 1 : 0) + (friend ? 1 : 0);
    const scoreW = 26;
    const nameMax = pw - (nx - x) - BOARD.pad - scoreW - icons * 22;
    fitName(ctx, mine ? 'you' : r.name, nx, y - 1, TYPE.body, color, weight, nameMax);
    if (!mine) {
      // A name is a button: underlined under the cursor, and a click opens the friend menu beside the board.
      const nameW = Math.min(ctx.measureText(r.name).width, Math.max(10, nameMax));
      names.push({ id: r.id, name: r.name, human: !!r.human, x: nx - 3, y: y - BOARD.row / 2, w: nameW + 6, h: BOARD.row, right: x });
      if (boardHover === r.id) { ctx.fillStyle = color; ctx.fillRect(nx, y + 6, nameW, 1.5); }
    }
    let ix = x + pw - BOARD.pad - scoreW - 4;
    if (friend) { ix -= 16; fillIcon(ctx, UI_ICONS.heart, ix + 6, y - 1, 12, FRIEND_COLOR); ix -= 4; }
    if (flags?.hunted) { ix -= 14; strokeIcon(ctx, UI_ICONS.target, ix + 6, y - 1, 13, PALETTE.hunted, 2.6); ix -= 8; }
    if (flags && flags.streak >= 2) { ix -= 20; fillIcon(ctx, UI_ICONS.flame, ix + 5, y - 1, 13, STREAK_FLAME); text(ctx, String(flags.streak), ix + 12, y, TYPE.micro, STREAK_FLAME, 'left', 800); }
    text(ctx, String(r.kills), x + pw - BOARD.pad - 2, y - 1, TYPE.title, PANEL_INK, 'right', 800);
    if (ffaTarget) {
      // A slim notch under the row: kills toward the round's target.
      const bx = nx, bw = pw - (nx - x) - BOARD.pad - 2;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(bx, y + 8, bw, 3);
      ctx.fillStyle = hex;
      ctx.fillRect(bx, y + 8, Math.max(2, bw * Math.min(1, r.kills / ffaTarget)), 3);
    }
    y = slotY + BOARD.row;
  });
  boardYs = rowYs;
  boardNames = names;
  ctx.globalAlpha = 1;
  return top + ph;
}

export const PANEL_ALPHA = { rest: 0.97, covering: 0.8 } as const;
const PANEL_FADE_MS = 180;

export function approachAlpha(alpha: number, covering: boolean, dtMs: number): number {
  const target = covering ? PANEL_ALPHA.covering : PANEL_ALPHA.rest;
  const step = (dtMs / PANEL_FADE_MS) * (PANEL_ALPHA.rest - PANEL_ALPHA.covering);
  return alpha < target ? Math.min(target, alpha + step) : Math.max(target, alpha - step);
}

type PanelId = 'score' | 'board' | 'minimap';
const panelAlpha: Record<PanelId, number> = { score: PANEL_ALPHA.rest, board: PANEL_ALPHA.rest, minimap: PANEL_ALPHA.rest };
const fadeRects: Partial<Record<PanelId, Rect>> = {};

export const drawnPanels = (): Readonly<Partial<Record<PanelId, Rect>>> => fadeRects;

function fadePanel({ ctx, snap, cam, dt }: Hud, id: PanelId, x: number, y: number, w: number, h: number): number {
  fadeRects[id] = { x, y, w, h };
  const pad = WORLD.playerRadius * cam.scale;
  const covering = snap.players.some((p) => {
    if (!p.alive) return false;
    const at = worldToScreen(cam, p);
    return at.x > x - pad && at.x < x + w + pad && at.y > y - pad && at.y < y + h + pad;
  });
  panelAlpha[id] = approachAlpha(panelAlpha[id], covering, dt);
  ctx.globalAlpha = panelAlpha[id];
  return panelAlpha[id];
}

const PING_WAVE_MS = 700;
const DIAMOND_R = 5;

function drawMinimap(hud: Hud, size: number) {
  const { ctx, w, h, snap, s, me, now } = hud;
  const k = size / s.worldSize;
  const pad = 8;
  // On a touch screen the bottom right is the aiming thumb's, so the minimap sits top left under the vitals, as in mobile shooters.
  const x0 = hud.P ? hud.P.minimap.x : touchScreen ? EDGE + inset().l : w - EDGE - inset().r - size - pad * 2;
  const y0 = hud.P ? hud.P.minimap.y : touchScreen ? EDGE + inset().t + VITALS.height + 8 : h - EDGE - inset().b - size - pad * 2;
  const base = fadePanel(hud, 'minimap', x0, y0, size + pad * 2, size + pad * 2);
  panel(ctx, x0, y0, size + pad * 2, size + pad * 2, MINIMAP.bg);
  // Caught by an enemy radar: everyone not on your side has you on their map, and this says for how long.
  if (snap.self.tagged) {
    const ph = 22, py = touchScreen ? y0 + size + pad * 2 + 4 : y0 - ph - 4;
    panel(ctx, x0, py, size + pad * 2, ph, MINIMAP.bg);
    text(ctx, `ON ENEMY RADAR · ${snap.self.tagged}s`, x0 + (size + pad * 2) / 2, py + ph / 2 + 1, TYPE.micro, RADAR_TAG, 'center', 800);
  }
  const x = x0 + pad, y = y0 + pad;
  for (const wall of s.walls) {
    ctx.fillStyle = wall.built ? MINIMAP.built : MINIMAP.block;
    if (wall.pts) {
      ctx.beginPath();
      for (let i = 0; i < wall.pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x + wall.pts[i]! * k, y + wall.pts[i + 1]! * k);
      ctx.closePath();
      ctx.fill();
      continue;
    }
    ctx.fillRect(x + wall.x * k, y + wall.y * k, Math.max(1.5, wall.w * k), Math.max(1.5, wall.h * k));
  }
  for (const z of snap.zones) {
    const zr = Math.max(4, z.r * k), zx = x + z.x * k, zy = y + z.y * k;
    ctx.beginPath();
    ctx.arc(zx, zy, zr, 0, TAU);
    ctx.fillStyle = z.owner ? TEAM_COLORS[z.owner] : PALETTE.neutral;
    ctx.globalAlpha = base * 0.45;
    ctx.fill();
    // The capture as a wedge in the taker's colour, and a flashing two-colour ring while both teams stand on it.
    if (z.capturing && z.progress > 0.01) {
      ctx.beginPath();
      ctx.moveTo(zx, zy);
      ctx.arc(zx, zy, zr, -Math.PI / 2, -Math.PI / 2 + Math.min(1, z.progress) * TAU);
      ctx.closePath();
      ctx.fillStyle = TEAM_COLORS[z.capturing];
      ctx.globalAlpha = base * 0.85;
      ctx.fill();
    }
    if (z.contested) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = Math.floor(now / 200) % 2 ? TEAM_COLORS.red : TEAM_COLORS.blue;
      ctx.globalAlpha = base;
      ctx.beginPath();
      ctx.arc(zx, zy, zr + 1.5, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = base;
  }
  for (const m of snap.minimap) {
    if (m.pingAge !== null) continue;
    if (m.friend) {
      // A friend: a heart in their own colour, ringed so it reads over any floor.
      fillIcon(ctx, UI_ICONS.heart, x + m.x * k, y + m.y * k, 11, '#ffffff');
      fillIcon(ctx, UI_ICONS.heart, x + m.x * k, y + m.y * k, 8, FRIEND_COLOR);
      continue;
    }
    ctx.fillStyle = m.team ? TEAM_COLORS[m.team] : '#ff6b5f';
    ctx.beginPath();
    ctx.arc(x + m.x * k, y + m.y * k, 2.5, 0, TAU);
    ctx.fill();
    // A radar tag: a blue ring that pings, round an enemy the sensor caught.
    if (m.tagged) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = RADAR_TAG;
      ctx.beginPath();
      ctx.arc(x + m.x * k, y + m.y * k, 5 + 1.5 * Math.sin(now / 200), 0, TAU);
      ctx.stroke();
    }
    // A Tracker mark: a ring round an enemy you hurt.
    if (m.marked) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ff5a1f';
      ctx.beginPath();
      ctx.arc(x + m.x * k, y + m.y * k, 5.5, 0, TAU);
      ctx.stroke();
    }
  }
  const inside = (v: number) => Math.min(size - DIAMOND_R, Math.max(DIAMOND_R, v));
  for (const m of snap.minimap) {
    if (m.pingAge === null) continue;
    const mx = x + inside(m.x * k), my = y + inside(m.y * k);
    const wave = m.pingAge / PING_WAVE_MS;
    if (wave < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, size, size);
      ctx.clip();
      ctx.globalAlpha = base * (1 - wave);
      ctx.beginPath();
      ctx.arc(mx, my, 4 + 12 * wave, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PALETTE.hunted;
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.moveTo(mx, my - DIAMOND_R);
    ctx.lineTo(mx + DIAMOND_R, my);
    ctx.lineTo(mx, my + DIAMOND_R);
    ctx.lineTo(mx - DIAMOND_R, my);
    ctx.closePath();
    ctx.fillStyle = PALETTE.hunted;
    ctx.fill();
  }
  if (snap.run) {
    for (const b of snap.buildings ?? []) {
      ctx.fillStyle = MINIMAP_BUILDING[b.kind];
      ctx.fillRect(x + b.cx * ZOM.cell * k, y + b.cy * ZOM.cell * k, Math.max(1.5, ZOM.cell * k), Math.max(1.5, ZOM.cell * k));
    }
    for (const kind of ZOMBIE_KINDS) {
      const r = Math.max(1.2, ZOMBIES[kind].radius / 10);
      ctx.fillStyle = ZOMBIE_LOOK[kind].body;
      ctx.beginPath();
      for (const [, k2, zx, zy] of snap.zombies ?? []) {
        if (ZOMBIE_KINDS[k2] !== kind) continue;
        ctx.moveTo(x + zx * k + r, y + zy * k);
        ctx.arc(x + zx * k, y + zy * k, r, 0, TAU);
      }
      ctx.fill();
    }
    const c = snap.run.core, half = Math.max(3, ZOM.coreHalf * k);
    ctx.fillStyle = hud.now - s.coreHitAt < CORE_ALERT_MS && Math.floor(hud.now / 200) % 2 ? PALETTE.hunted : '#4fd1e8';
    ctx.fillRect(x + c.x * k - half, y + c.y * k - half, half * 2, half * 2);
  }
  drawAirdropMap(ctx, snap.airdrop, serverNow(s.snaps, hud.now), hud.now, x, y, k, size, base);
  const clockNow = snap.royale ? serverNow(s.snaps, hud.now) : null;
  if (snap.royale && clockNow !== null) {
    drawRingMap(ctx, snap.royale, clockNow, hud.now, x, y, k, size);
    ctx.globalAlpha = base;
    const lines = hud.P ? [] : [ringLine(snap.royale, clockNow), ...(snap.royale.redeploys ? [] : ['Last lives'])];
    // Above the minimap, or on a phone (where the vitals sit above it) beside it, clear of the play area.
    const beside = (line: string) => { setFont(ctx, 700, TYPE.label + 1); return x0 + size + pad * 2 + 8 + (ctx.measureText(line).width + (TYPE.label + 1) * 1.4) / 2; };
    lines.forEach((line, i) => platedLine(ctx, line, hud.P ? beside(line) : x0 + (size + pad * 2) / 2, hud.P ? y0 + 14 + i * 28 : y0 - 16 - (lines.length - 1 - i) * 28, TYPE.label + 1, i === 0 ? PANEL_INK : PALETTE.lossOnDark, 700));
  }
  const self = me ?? s.lastSelf;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + self.x * k, y + self.y * k, 3.5, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPill(hud: Hud, compact: boolean): number {
  const { ctx, w, snap, me, s, now } = hud;
  const ph = compact ? 24 : 28, y = hud.P ? hud.P.topChip.y : EDGE + inset().t;
  const side = compact ? 40 : 48, mid = compact ? 56 : 66;
  const big = compact ? 14 : 16;
  const left = timeLeft(hud);
  const cy = y + ph / 2;
  if (snap.match.mode === 'TDM' || snap.match.mode === 'DOM') return drawTeamBanner(hud, y, compact, left);
  if (snap.royale) {
    const pill = ringPill(snap.royale, serverNow(s.snaps, now) ?? snap.royale.ring.shrinkAt);
    const lw = compact ? 70 : 86;
    const x = w / 2 - (lw + mid) / 2;
    fadePanel(hud, 'score', x, y, lw + mid, ph);
    panel(ctx, x, y, lw + mid, ph);
    text(ctx, pill.label, x + lw / 2 + 4, cy + 1, TYPE.label + 1, '#c9b3ff', 'center', 800);
    text(ctx, pill.time, x + lw + mid / 2 - 4, cy + 1, TYPE.body, PANEL_INK, 'center', 600);
    return y + ph;
  }
  if (snap.run) {
    const run = snap.run;
    const [label, color] = run.phase === 'day' ? [`DAY ${run.night}`, PALETTE.gold] : run.phase === 'night' ? [`NIGHT ${run.night}`, '#a99bff'] : run.report?.won ? ['HELD', PALETTE.hpGood] : ['FALLEN', PALETTE.hunted];
    const until = run.phaseEndsAt === null ? null : run.phaseEndsAt - (serverNow(s.snaps, now) ?? run.phaseEndsAt);
    const center = run.phase === 'night' ? `${run.waveLeft} left` : until === null ? '' : clock(until);
    const lw = compact ? 64 : 78;
    const x = w / 2 - (lw + mid) / 2;
    fadePanel(hud, 'score', x, y, lw + mid, ph);
    panel(ctx, x, y, lw + mid, ph);
    text(ctx, label, x + lw / 2 + 4, cy + 1, TYPE.label + 1, color, 'center', 800);
    text(ctx, center, x + lw + mid / 2 - 4, cy + 1, TYPE.body, PANEL_INK, 'center', 600);
    return y + ph;
  }
  if (snap.range) {
    const lw = compact ? 110 : 132, x = w / 2 - lw / 2;
    fadePanel(hud, 'score', x, y, lw, ph);
    panel(ctx, x, y, lw, ph);
    text(ctx, 'RANGE · PRACTICE', x + lw / 2, cy + 1, TYPE.label + 1, '#8fd6e0', 'center', 800);
    return y + ph;
  }
  return drawTimerToken(hud, y, left === null ? MAP_MS.FFA : left, left !== null);
}

/** Which round the objective text was first shown for, so the full line is spelled out once and a compact emblem chip takes over. */
const objectiveSeen = { key: '', at: 0 };
const OBJECTIVE_TEXT_MS = 8000;

function drawObjectiveLine(hud: Hud, top: number, full: boolean): number {
  const { ctx, w, snap, me } = hud;
  if (!me) return top;
  const key = `${snap.match.mode}|${snap.match.map}`;
  if (objectiveSeen.key !== key) { objectiveSeen.key = key; objectiveSeen.at = hud.now; }
  const spelled = full || hud.now - objectiveSeen.at < OBJECTIVE_TEXT_MS;
  const lines: [string, string][] = [];
  const chip = !spelled && !snap.run && !snap.royale && snap.match.mode === 'FFA';
  if (spelled) lines.push([snap.run ? `${snap.match.map} · ${phaseLine(snap.run, serverNow(hud.s.snaps, hud.now))}` : `${snap.match.map} · ${objectiveFor(snap.match.mode, me.team, timeLeft(hud)).line}`, PANEL_INK]);
  const notice = mapNotice(snap.match);
  if (notice) lines.push([notice, PALETTE.gold]);
  let y = top + 6;
  if (chip) {
    // The compact objective: a target pin and the kills that win the round.
    setFont(ctx, 800, TYPE.title);
    const nw = ctx.measureText(String(WORLD.ffaWinKills)).width;
    setFont(ctx, 800, TYPE.micro);
    const uw = ctx.measureText('KILLS').width;
    const cw = 34 + nw + 6 + uw + 12;
    panel(ctx, w / 2 - cw / 2, y, cw, 24);
    pin(ctx, w / 2 - cw / 2 + 17, y + 11, 8, ACCENT);
    strokeIcon(ctx, UI_ICONS.target, w / 2 - cw / 2 + 17, y + 11, 11, CEL.ink, 2.6);
    text(ctx, String(WORLD.ffaWinKills), w / 2 - cw / 2 + 31, y + 12, TYPE.title, PANEL_INK, 'left', 800);
    text(ctx, 'KILLS', w / 2 - cw / 2 + 37 + nw, y + 14, TYPE.micro, PANEL_MUTED, 'left', 800);
    y += 28;
  }
  for (const [line, color] of lines) {
    setFont(ctx, 600, TYPE.label);
    const lw = ctx.measureText(line).width + 18;
    panel(ctx, w / 2 - lw / 2, y, lw, 20);
    text(ctx, line, w / 2, y + 10, TYPE.label, color, 'center', 600);
    y += 24;
  }
  return y - 4;
}

function drawSiege(hud: Hud, run: NonNullable<Snapshot['run']>, top: number, compact: boolean) {
  if (hud.P) return drawPhoneSiege(hud, hud.P, run);
  const { ctx, w, h, s, me, now } = hud;
  const y = top + 17;
  const cx = w / 2;
  setFont(ctx, 750, TYPE.body);
  const scrapW = ctx.measureText(`${run.scrap}`).width;
  const frac = run.core.hp / run.core.maxHp;
  const alert = now - s.coreHitAt < CORE_ALERT_MS;
  const coreColor = alert && Math.floor(now / 200) % 2 ? PALETTE.hunted : frac > 0.5 ? PALETTE.hpGood : frac > 0.25 ? PALETTE.gold : PALETTE.hpBad;
  const people = `${run.survivors}`;
  const peopleW = ctx.measureText(people).width;
  const mourned = run.phase === 'night' && run.lost > 0 ? `−${run.lost} tonight` : null;
  setFont(ctx, 500, TYPE.label);
  const scrapLabelW = ctx.measureText('scrap').width, peopleLabelW = ctx.measureText('survivors').width;
  setFont(ctx, 700, TYPE.label);
  const mournedW = mourned ? ctx.measureText(mourned).width + 8 : 0;
  const total = 16 + scrapW + 6 + scrapLabelW + 14 + 16 + 90 + 14 + peopleW + 6 + peopleLabelW + mournedW;
  let x = cx - total / 2;
  panel(ctx, x - 10, y - 12, total + 20, 24);
  strokeIcon(ctx, UI_ICONS.scrap, x + 6, y, 12, PALETTE.gold, 2.2);
  text(ctx, `${run.scrap}`, x + 16, y, TYPE.body, PANEL_INK, 'left', 750);
  x += 16 + scrapW + 6;
  text(ctx, 'scrap', x, y, TYPE.label, PANEL_MUTED, 'left', 500);
  x += scrapLabelW + 14;
  strokeIcon(ctx, UI_ICONS.core, x + 6, y, 12, coreColor, 2.2);
  bar(ctx, x + 16, y - 3, 90, 6, frac, coreColor, 'rgba(255, 255, 255, 0.18)');
  x += 16 + 90 + 14;
  text(ctx, people, x, y, TYPE.body, alert ? coreColor : PANEL_INK, 'left', 750);
  text(ctx, 'survivors', x + peopleW + 6, y, TYPE.label, PANEL_MUTED, 'left', 500);
  if (mourned) text(ctx, mourned, x + peopleW + 6 + peopleLabelW + 8, y, TYPE.label, PALETTE.lossOnDark, 'left', 700);
  let below = y + 30;
  if (alert) below += drawCoreAlert(hud, run.core, below) + 6;
  if (run.phase === 'over') return;
  if (run.phase === 'day') platedLine(ctx, `Tonight · ${forecast(run.night, squadShare(hud.snap.players))}`, cx, below, TYPE.body, PALETTE.gold, 700, ACCENT);
  if (me?.downed) {
    drawDownedSelf(hud, me.downed);
    return;
  }
  if (!me?.alive) return;
  const use = useHint(hud.snap, s.lastSelf);
  const row = h - (compact ? 150 : 30);
  if (use) platedLine(ctx, use, w / 2, h * 0.64, TYPE.body + 1, PALETTE.gold, 750, ACCENT);
  if (s.building) {
    const rows = buildRows();
    rows.forEach((r, i) => hintBar(ctx, s, r.chips, w / 2, row - 32 * (rows.length - i), r.label));
    const hover = s.buildGhost?.hover ?? null;
    const controls = BUILD_CONTROLS.map((c) => (c.pick && 'upgrade' in c.pick ? { ...c, what: hover ? (hover.next ? `upgrade to ${hover.next.name} ${hover.next.cost}` : 'upgrade (top level)') : 'upgrade' } : c));
    hintBar(ctx, s, controls, w / 2, row, 'BUILD');
  } else if (run.phase === 'day' || buildsByNight(hud.snap)) {
    const hints = run.phase === 'day'
      ? [{ key: 'B', what: 'build walls, turrets and more' }, { key: 'N', what: readyHint(run, hud.snap.players, hud.snap.self.id) }]
      : [{ key: 'B', what: NIGHT_BUILD_HINT }];
    hintBar(ctx, s, hints, w / 2, row, null);
    const up = upgradeTarget(hud.snap, s.lastSelf);
    if (up && run.scrap >= up.cost) platedLine(ctx, `U to upgrade the ${up.b.kind === 'wall' ? 'wall' : up.b.kind} to ${up.to} · ${up.cost} scrap`, w / 2, h * 0.64 + 34, TYPE.body, PALETTE.gold, 700, ACCENT);
  }
}

/** You're down: a red-edged plate with the title, how long you have or who is reviving you, and the revive bar. */
function drawDownedSelf({ ctx, w, h, s, now }: Hud, downed: NonNullable<PlayerView['downed']>) {
  const k = 0.5 + 0.5 * Math.sin(now / 260);
  const line = downedLine(downed, serverNow(s.snaps, now));
  const y = h * 0.64;
  setFont(ctx, 850, 24);
  const tw = ctx.measureText("You're down").width;
  setFont(ctx, 650, TYPE.body + 1);
  const pw = Math.max(tw, ctx.measureText(line).width, 180) + 36, ph = 78;
  const left = w / 2 - pw / 2, top = y - 18;
  ctx.globalAlpha = 0.92;
  plate(ctx, left, top, pw, ph);
  ctx.fillStyle = PANEL_FILL;
  ctx.fill();
  ctx.globalAlpha = 1;
  panels.push({ x: left, y: top, w: pw, h: ph });
  ctx.fillStyle = PALETTE.hunted;
  ctx.fillRect(left, top, pw - PANEL_CUT, 3);
  text(ctx, "You're down", w / 2, y + 1, 24, PALETTE.hunted, 'center', 850);
  text(ctx, line, w / 2, y + 26, TYPE.body + 1, PANEL_INK, 'center', 650);
  ctx.globalAlpha = 0.6 + 0.4 * k;
  bar(ctx, w / 2 - 90, y + 44, 180, 5, downed.revive, PALETTE.hpGood, ON_PANEL.track);
  ctx.globalAlpha = 1;
}

function drawRoyale(hud: Hud, royale: NonNullable<Snapshot['royale']>, top: number) {
  if (hud.P) return drawPhoneRoyale(hud, hud.P, royale);
  const { ctx, w, h, snap, s, me, now } = hud;
  const mine = me?.team ?? null;
  const box = trackerSize(royale.squads.length);
  const x = w / 2 - box.w / 2 - 6, y = top + 6;
  panel(ctx, x, y, box.w + 12, box.h + 8);
  panels.push({ x, y, w: box.w + 12, h: box.h + 8 });
  drawTracker(ctx, royale, mine, x + 6, y + 4);
  if (me?.downed) { drawDownedSelf(hud, me.downed); return; }
  const revive = reviveHint(snap, me);
  if (revive) platedLine(ctx, revive, w / 2, h * 0.64, TYPE.body + 1, PALETTE.gold, 750, ACCENT);
  if (me?.alive) return;
  const clockNow = serverNow(s.snaps, now);
  if (clockNow === null) return;
  const lines = spectateLines(snap, royale, clockNow);
  platedLine(ctx, lines.title, w / 2, h - 100, TYPE.title + 2, PANEL_INK, 800, ACCENT);
  platedLine(ctx, lines.sub, w / 2, h - 66, TYPE.body, PANEL_MUTED, 650);
}

function hintBar(ctx: CanvasRenderingContext2D, s: Session, hints: readonly HintChip[], cx: number, row: number, label: string | null) {
  setFont(ctx, 650, TYPE.label);
  const parts = hints.map((p) => ({ ...p, kw: ctx.measureText(p.key).width + 10, ww: ctx.measureText(p.what).width }));
  setFont(ctx, 850, TYPE.label);
  const labelW = label ? ctx.measureText(label).width + 12 : 0;
  setFont(ctx, 650, TYPE.label);
  const total = parts.reduce((t, p) => t + p.kw + p.ww + 22, labelW) + 8;
  let hx = cx - total / 2;
  panel(ctx, hx, row - 12, total, 24);
  hx += 10;
  if (label) {
    text(ctx, label, hx, row, TYPE.label, PALETTE.gold, 'left', 850);
    hx += labelW;
  }
  const hover = s.buildGhost?.hover ?? null;
  for (const p of parts) {
    const pick = p.pick;
    const picked = pick !== undefined && 'kind' in pick && pick.kind === s.buildKind && (pick.kind !== 'wall' || pick.lv === s.buildTier);
    // The upgrade chip lights only while a building that can step up is hovered.
    const lit = pick !== undefined && 'upgrade' in pick && !!hover?.next && s.buildGhost?.upgrade === null;
    // The key is a keycap: a lit top, a lip under it and an ink edge.
    cel(ctx, hx, row - 8, p.kw, 14, picked || lit ? PALETTE.gold : '#ece6d6', 3, 2);
    text(ctx, p.key, hx + 5, row - 1, TYPE.label, CEL.ink, 'left', 800);
    text(ctx, p.what, hx + p.kw + 5, row, TYPE.label, picked || lit ? PALETTE.gold : PANEL_MUTED, 'left', picked || lit ? 750 : 550);
    if (pick) buildChips.push({ pick, x: hx - 4, y: row - 12, w: p.kw + p.ww + 12, h: 24 });
    hx += p.kw + p.ww + 22;
  }
}

/** The build bar's chips as last drawn, in CSS px, so a click or tap on one picks its kind or upgrades the hovered building. */
let buildChips: (Rect & { pick: BuildChip })[] = [];
export const drawnBuildChips = (): readonly (Rect & { pick: BuildChip })[] => buildChips;
export const buildChipAt = (sx: number, sy: number): BuildChip | null => {
  const x = sx / hudScale, y = sy / hudScale;
  return buildChips.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)?.pick ?? null;
};

/** Returns the height of the warning's plate, so lines below it can stand clear. */
function drawCoreAlert({ ctx, w, h, now, cam, selfAt }: Hud, core: { x: number; y: number }, y: number): number {
  const pulse = 0.5 + 0.5 * Math.sin(now / 110);
  ctx.globalAlpha = 0.75 + 0.25 * pulse;
  const tall = platedLine(ctx, 'CORE UNDER ATTACK', w / 2, y, TYPE.body, PALETTE.hunted, 850, PALETTE.hunted);
  ctx.globalAlpha = 1;
  const at = edgePoint(selfAt, worldToScreen(cam, core), w, h, EDGE_INSET + 10);
  if (!at) return tall;
  const clear = clearOfRects(selfAt, at, panels, ARROW_CLEARANCE);
  edgeArrow(ctx, clear, at.angle, 1.25 + 0.2 * pulse, 1);
  strokeIcon(ctx, UI_ICONS.core, clear.x - Math.cos(at.angle) * 24, clear.y - Math.sin(at.angle) * 24, 15, PALETTE.hunted, 2.4);
  return tall;
}

/** Players who ask the OS for less motion keep the HUD's colour cues but lose the pops, throbs, glints and sparkles. */
/** The bible's heal green and its hottest spark, the only near-whites the HUD's effects use. */
const HEAL = '#8ff0c4';
const SPARK_WHITE = '#ffe9b0';
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 1 as a cue starts, easing to 0 over `ms`; 0 before and after (and always with reduced motion). */
const popOf = (age: number, ms: number): number => (REDUCED || age < 0 || age > ms ? 0 : 1 - age / ms);

function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const m = (i: number) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

type Spark = { x: number; y: number; vx: number; vy: number; born: number; life: number; r: number; color: string };
let sparks: Spark[] = [];

/** A burst of four-point glints flying out from a point, in HUD space. */
function burst(x: number, y: number, n: number, color: string, speed: number, now: number, r: number) {
  if (REDUCED) return;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.random() * 0.6;
    const v = speed * (0.45 + Math.random() * 0.75);
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 8, born: now, life: 520 + Math.random() * 380, r: r * (0.6 + Math.random() * 0.7), color: i % 3 === 0 ? SPARK_WHITE : color });
  }
  if (sparks.length > 90) sparks = sparks.slice(-90);
}

function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r : r * 0.26;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function drawSparks(ctx: CanvasRenderingContext2D, now: number) {
  if (!sparks.length) return;
  sparks = sparks.filter((p) => now - p.born < p.life);
  for (const p of sparks) {
    const age = now - p.born;
    const t = age / p.life, sec = age / 1000;
    ctx.globalAlpha = (1 - t) * (0.6 + 0.4 * Math.sin(age / 75));
    ctx.fillStyle = p.color;
    starPath(ctx, p.x + p.vx * sec * (1 - t * 0.4), p.y + p.vy * sec + 40 * sec * sec, p.r * (1 - t * 0.5), age / 160);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** A soft diagonal band of light crossing a rect left to right as `t` runs 0 to 1. */
function sheen(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number, color: string) {
  if (REDUCED || w < 4) return;
  const bw = Math.max(10, w * 0.35);
  const bx = x - bw + (w + bw) * t;
  const x0 = Math.max(x, bx), x1 = Math.min(x + w, bx + bw);
  if (x1 <= x0) return;
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y, x1 - x0, h);
}

/** What the vitals plate remembers between frames so its numbers roll and its cues fire once. */
const vfx = {
  id: -1, at: -1e9, hp: 0, shownHp: 0, trail: 1, hold: 0, hurtAt: -1e9, healAt: -1e9, armor: 1, armorAt: -1e9, armorUpAt: -1e9,
  ammo: 0, ammoAt: -1e9, topN: 0, topAt: -1e9, level: 0, levelAt: -1e9, shownFrac: 0, shownScore: 0, streak: 0, streakAt: -1e9, abilitySpark: -1, levelBurst: false,
};

function stepVitals({ dt, now }: Hud, me: PlayerView, self: SelfView, displayLevel: number, frac: number) {
  const hpFrac = me.hp / me.maxHp;
  const fresh = vfx.id !== me.id || now - vfx.at > 400;
  vfx.id = me.id;
  vfx.at = now;
  if (fresh) {
    Object.assign(vfx, { armor: armorFrac(me), armorAt: -1e9, armorUpAt: -1e9, hp: me.hp, shownHp: me.hp, trail: hpFrac, ammo: self.ammo, level: displayLevel, shownFrac: frac, shownScore: me.score, streak: self.streak, hurtAt: -1e9, healAt: -1e9 });
    sparks = [];
    return;
  }
  if (me.hp < vfx.hp - 0.5) { vfx.hurtAt = now; vfx.hold = now + 360; vfx.trail = Math.max(vfx.trail, vfx.hp / me.maxHp); }
  else if (me.hp > vfx.hp + 0.5) vfx.healAt = now;
  vfx.hp = me.hp;
  const armor = armorFrac(me);
  if (armor !== vfx.armor) { vfx.armorAt = now; if (armor > vfx.armor + 0.01) vfx.armorUpAt = now; vfx.armor = armor; }
  if (hpFrac > vfx.trail) vfx.trail = hpFrac;
  else if (now > vfx.hold) vfx.trail = Math.max(hpFrac, vfx.trail - dt * 0.0007);
  const ease = REDUCED ? 1 : 1 - Math.exp(-dt / 90);
  vfx.shownHp += (me.hp - vfx.shownHp) * ease;
  if (Math.abs(vfx.shownHp - me.hp) < 0.5) vfx.shownHp = me.hp;
  if (self.ammo !== vfx.ammo) vfx.ammoAt = now;
  vfx.ammo = self.ammo;
  if (displayLevel > vfx.level) { vfx.levelAt = now; vfx.shownFrac = 0; vfx.levelBurst = true; }
  vfx.level = displayLevel;
  vfx.shownFrac += (frac - vfx.shownFrac) * (REDUCED ? 1 : 1 - Math.exp(-dt / 140));
  vfx.shownScore += (me.score - vfx.shownScore) * (REDUCED ? 1 : 1 - Math.exp(-dt / 160));
  if (Math.abs(vfx.shownScore - me.score) < 0.6) vfx.shownScore = me.score;
  if (self.streak > vfx.streak) vfx.streakAt = now;
  vfx.streak = self.streak;
}

/** The corner kit's height on a touch screen, the health cross with the kit beside it (the touch minimap sits just below it). */
const VITALS = { height: 84 + 4 } as const;
const AMMO = { live: '#e6b850', liveLow: ACCENT, spent: '#2a2f38', empty: PALETTE.hpBad, pipsMax: 20 } as const;
const STATUS = { shield: '#6eb4ff', rush: HEAL, sprint: ACCENT } as const;
/** Where the vitals plate's origin is on the HUD, so sparks (drawn in HUD space) can start from inside it. */
const vitalsAt = { x: 0, y: 0 };

/** A raised chip with a lip under it: used by the status tabs and the perk icons. */
function cel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, face: string, r = 4, lip = 2) {
  ctx.lineWidth = 2;
  ctx.strokeStyle = CEL.ink;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h + lip, r);
  ctx.fillStyle = mixHex(face, '#000000', 0.38);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.stroke();
}

/** A coloured status tab with ink text. Returns its width. */
function statusTab(ctx: CanvasRenderingContext2D, x: number, cy: number, label: string, color: string, icon: string | null): number {
  setFont(ctx, 800, TYPE.micro);
  const w = ctx.measureText(label).width + (icon ? 29 : 14);
  cel(ctx, x, cy - 8, w, 16, color, 4, 2);
  if (icon) strokeIcon(ctx, icon, x + 11, cy, 12, CEL.ink, 2.6);
  text(ctx, label, x + (icon ? 20 : 7), cy + 0.5, TYPE.micro, CEL.ink, 'left', 800);
  return w;
}

const hpColor = (frac: number): string => (frac > 0.5 ? PALETTE.hpGood : frac > 0.35 ? '#ffb347' : frac > 0.15 ? ACCENT : PALETTE.hpBad);

/**
 * Health, read like TF2's: a chunky cross bottom left (top left on a touch screen, clear of the move stick) with one big figure on it,
 * the cross filling from the bottom in the health colour. Low health (35% and under) throbs red round the cross, faster when
 * critical (15%); a hit flashes the fill pale and pops the figure, a heal glows green, and a shield rings it blue. Flat shapes,
 * an ink outline and one hard shadow, like the rest of the kit.
 */
export const HEALTH = { size: 104, compactSize: 84, phoneSize: 52, arm: 0.48, figure: 46, compactFigure: 38, phoneFigure: 25, low: 0.35, critical: 0.15, flashMs: 280, healMs: 480 } as const;
export type HealthState = 'ok' | 'hurt' | 'low' | 'critical';
export type HealthLook = { figure: string; frac: number; state: HealthState; tone: string; flash: number; heal: number; pulse: number };

/** What the health block shows for `shownHp` (the rolling figure) of `maxHp`, `now` ms after the last hit and heal. Pure, for the tests. */
export function healthLook(hp: number, maxHp: number, shownHp: number, now: number, hurtAt: number, healAt: number, reduced = REDUCED): HealthLook {
  const frac = Math.max(0, Math.min(1, hp / maxHp));
  const state: HealthState = frac <= HEALTH.critical ? 'critical' : frac <= HEALTH.low ? 'low' : frac <= 0.5 ? 'hurt' : 'ok';
  const fade = (age: number, ms: number) => (age < 0 || age > ms ? 0 : 1 - age / ms);
  const throb = (state === 'low' || state === 'critical') && !reduced ? 0.5 + 0.5 * Math.sin(now / (state === 'critical' ? 150 : 260)) : 0;
  return { figure: String(Math.max(0, Math.ceil(shownHp))), frac, state, tone: hpColor(frac), flash: fade(now - hurtAt, HEALTH.flashMs), heal: fade(now - healAt, HEALTH.healMs), pulse: throb };
}

function crossPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const a = s * HEALTH.arm, o = (s - a) / 2;
  ctx.beginPath();
  ctx.moveTo(x + o, y);
  ctx.lineTo(x + o + a, y);
  ctx.lineTo(x + o + a, y + o);
  ctx.lineTo(x + s, y + o);
  ctx.lineTo(x + s, y + o + a);
  ctx.lineTo(x + o + a, y + o + a);
  ctx.lineTo(x + o + a, y + s);
  ctx.lineTo(x + o, y + s);
  ctx.lineTo(x + o, y + o + a);
  ctx.lineTo(x, y + o + a);
  ctx.lineTo(x, y + o);
  ctx.lineTo(x + o, y + o);
  ctx.closePath();
}

/** The health cross at (x, y), `s` square: glows (shield, heal, low), shadow, the back in your colour, the fill, the outline, the figure. */
function drawHealthCross(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, look: HealthLook, accent: string, shield: 'spawn' | 'perk' | null, now: number) {
  ctx.lineJoin = 'round';
  const glowAt = (color: string, alpha: number, width: number) => {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    crossPath(ctx, x, y, s);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  if (shield) glowAt(STATUS.shield, shield === 'spawn' && !REDUCED ? 0.55 + 0.3 * Math.sin(now / 200) : 0.75, 12);
  glowAt(PALETTE.hpBad, look.state === 'critical' || look.state === 'low' ? (REDUCED ? 0.6 : 0.3 + 0.6 * look.pulse) : 0, 10);
  glowAt(HEAL, look.heal * 0.9, 10);
  ctx.fillStyle = CEL.shadow;
  ctx.translate(3, 4);
  crossPath(ctx, x, y, s);
  ctx.fill();
  ctx.translate(-3, -4);
  ctx.save();
  crossPath(ctx, x, y, s);
  // Low health stains the empty cross red, throbbing (steady with reduced motion), the way TF2's cross flashes.
  const back = mixHex('#23272e', accent, 0.2);
  const danger = look.state === 'critical' || look.state === 'low';
  ctx.fillStyle = danger ? mixHex(back, '#8a1a14', REDUCED ? 0.7 : 0.4 + 0.5 * look.pulse) : back;
  ctx.fill();
  ctx.clip();
  // The pale chunk a hit just took, held a moment, then the fill.
  const top = y + s * (1 - look.frac);
  const trailTop = y + s * (1 - Math.max(look.frac, Math.min(1, vfx.trail)));
  if (trailTop < top - 0.5) { ctx.fillStyle = '#f2c27a'; ctx.fillRect(x, trailTop, s, top - trailTop); }
  ctx.fillStyle = look.flash > 0 ? mixHex(look.tone, '#fff1d2', look.flash * 0.85) : look.tone;
  ctx.fillRect(x, top, s, y + s - top);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(x, y + s - 5, s, 5);
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = CEL.ink;
  crossPath(ctx, x, y, s);
  ctx.stroke();
  const size = (s === HEALTH.size ? HEALTH.figure : s === HEALTH.phoneSize ? HEALTH.phoneFigure : HEALTH.compactFigure) * (1 + 0.12 * look.flash);
  const ink = look.heal > 0 ? mixHex('#ffffff', HEAL, look.heal) : look.state === 'critical' || look.state === 'low' ? mixHex('#ffffff', '#ffb3b3', look.pulse) : '#ffffff';
  inked(ctx, look.figure, x + s / 2, y + s / 2 + 1, size, ink, 800, 'center');
}

/** The armor worn as a small shield chip with a pip per tier (light, medium, heavy). Returns its width, 0 when none is worn. */
/** The armor chip beside the cross: the shield, the tier's pips, and under them the pool left, steel blue; empty, the chip greys out. */
function drawArmorChip(ctx: CanvasRenderingContext2D, x: number, cy: number, tier: number, frac: number, now: number): number {
  if (tier <= 0) return 0;
  const w = 50;
  const empty = frac <= 0;
  const up = popOf(now - vfx.armorUpAt, 420);
  cel(ctx, x, cy - 10, w, 20, empty ? '#2a2f38' : up > 0 ? mixHex('#3d4450', ARMOR.fill, up * 0.6) : '#3d4450', 4, 2);
  fillIcon(ctx, PERK_ICONS.shield, x + 12, cy, 14, empty ? ARMOR.empty : PANEL_INK);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < tier ? (empty ? ARMOR.empty : PANEL_INK) : 'rgba(236, 230, 214, 0.2)';
    ctx.fillRect(x + 23 + i * 8, cy - 6, 5, 7);
  }
  ctx.fillStyle = ARMOR.track;
  ctx.fillRect(x + 23, cy + 3, 21, 3);
  ctx.fillStyle = ARMOR.fill;
  ctx.fillRect(x + 23, cy + 3, 21 * frac, 3);
  return w;
}

type SelfView = Snapshot['self'];

function streakBadgeWidth(ctx: CanvasRenderingContext2D, streak: number): number {
  setFont(ctx, 850, TYPE.body);
  return ctx.measureText(`${streak}`).width + 26;
}

function huntedBadgeWidth(ctx: CanvasRenderingContext2D): number {
  setFont(ctx, 800, TYPE.micro);
  return ctx.measureText('HUNTED').width + 24;
}

/** Your kills this life, once there are two: a flame and the count, hotter-looking as it climbs. */
function drawStreakBadge(ctx: CanvasRenderingContext2D, x: number, y: number, streak: number, now: number) {
  const label = `${streak}`;
  const bw = streakBadgeWidth(ctx, streak);
  const heat = Math.min(1, (streak - 1) / 8);
  const pop = popOf(now - vfx.streakAt, 260);
  const grow = 1 + 0.05 * Math.min(8, streak - 2) + 0.42 * pop;
  const cx = x + bw / 2;
  ctx.translate(cx, y);
  ctx.scale(grow, grow);
  if (heat > 0.2 && !REDUCED) {
    ctx.globalAlpha = 0.25 + 0.2 * Math.sin(now / 120) + heat * 0.25;
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.roundRect(-bw / 2 - 3, -13, bw + 6, 26, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.roundRect(-bw / 2, -10, bw, 20, 4);
  ctx.fillStyle = mixHex('#e8481a', '#ffa21f', heat);
  ctx.fill();
  const flick = REDUCED ? 1 : 1 + 0.12 * Math.sin(now / 70 + streak) * (0.4 + heat);
  ctx.translate(-bw / 2 + 10, -0.5);
  ctx.scale(1, flick);
  fillIcon(ctx, UI_ICONS.flame, 0, 0, 13 + heat * 3, '#fff4e0');
  ctx.scale(1, 1 / flick);
  ctx.translate(bw / 2 - 10, 0.5);
  text(ctx, label, -bw / 2 + 19, 0.5, TYPE.body, '#ffffff', 'left', 850);
  ctx.scale(1 / grow, 1 / grow);
  ctx.translate(-cx, -y);
}

function drawHuntedBadge(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  setFont(ctx, 800, TYPE.micro);
  const bw = ctx.measureText('HUNTED').width + 24;
  ctx.beginPath();
  ctx.roundRect(x, y - 9, bw, 18, 4);
  ctx.fillStyle = PALETTE.hunted;
  ctx.fill();
  strokeIcon(ctx, UI_ICONS.target, x + 9, y, 10, '#ffffff', 2.2);
  text(ctx, 'HUNTED', x + 17, y + 0.5, TYPE.micro, '#ffffff', 'left', 800);
  return bw;
}

const ABILITY_TIER: Tier = 3;
export const ABILITY_SCORE = LEVELS.find((l) => l.pick?.k === 'perk' && l.pick.tier === ABILITY_TIER)?.score;

export const abilityHint = (pending: PendingPick | null): [string, string] =>
  pending?.k === 'perk' && pending.tier === ABILITY_TIER ? ['Pick an', 'ability'] : ['Ability', `at ${ABILITY_SCORE}`];

/* ---------------------------------------------------------------------------------------------------------------------------
 * Toy-box vitals: no panel. Each readout is its own drawn object in the game's ink-and-cel style, so the HUD reads as part of the
 * toy-soldier world yet stays apart from the floor (ink outline, hard down-right shadow): a health cross bottom left (see HEALTH),
 * an inked count for ammo, and the loadout strip of picked tiles under a plain progress line top left (see drawLoadout); the ammo count rides beside the reticle (a near-the-gun readout is read fastest), or beside your soldier on a touch screen,
 * where there is no cursor to follow.
 * ------------------------------------------------------------------------------------------------------------------------- */
let hudCrosshair: Point = { x: 0, y: 0 };

/** Text over the world: bone (or any colour) with a fat ink stroke, so it holds on a light floor and a dark one. */
function inked(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight: number, align: CanvasTextAlign = 'left') {
  setFont(ctx, weight, size);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 4);
  ctx.strokeStyle = CEL.ink;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** A round enamel pin: ink ring, lip below, lit face, specular dot. */
function pin(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, face: string) {
  ctx.fillStyle = CEL.shadow;
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 4, r + 2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(cx, cy + 2, r + 2, 0, TAU);
  ctx.arc(cx, cy, r + 2, 0, TAU);
  ctx.rect(cx - r - 2, cy, (r + 2) * 2, 2);
  ctx.fill();
  ctx.fillStyle = mixHex(face, '#000000', 0.4);
  ctx.beginPath();
  ctx.arc(cx, cy + 2, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.35, cy - r * 0.4, r * 0.22, 0, TAU);
  ctx.fill();
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The loadout strip, top left on a desktop (loadout.ts says what is in it): one plain progress line ("LV 2  Next: Perk · 520 / 700")
 * and under it a tile for each thing picked this life (the evolved gun, the attachment, the perk, the ability), each with its icon
 * and a short name. Nothing is drawn for what is still locked; a tile stamps in as its pick lands. Hovering a tile with the cursor
 * shows its name and what it does. The ability's tile is the ability readout: a sweep while it cools, orange with a glow and its key
 * when it is ready. On a phone the ability lives on its button, so the picks fold to small pins beside the level, on demand.
 * ------------------------------------------------------------------------------------------------------------------------- */
const RANK = { h: 26, gap: 10, bar: 3 } as const;
const SLOT_POP_MS = 320;
const SLOT_LABEL_H = 18;
type SeenSlot = { born: number; x: number; sparked: boolean };
const slotsSeen = new Map<string, SeenSlot>();
let slotsLife = -1;
type DrawnSlot = SlotBox & { kind: SlotKind; label: string; name: string };
let loadoutDrawn: { rank: Rect | null; slots: DrawnSlot[]; card: Rect | null } = { rank: null, slots: [], card: null };
/** Where the strip was last drawn, in screen px (the dev probe and the verify scripts hover its tiles with this). */
export const drawnLoadout = (): { rank: Rect | null; slots: DrawnSlot[]; card: Rect | null } => {
  const z = (r: Rect) => ({ x: r.x * hudScale, y: r.y * hudScale, w: r.w * hudScale, h: r.h * hudScale });
  return { rank: loadoutDrawn.rank && z(loadoutDrawn.rank), slots: loadoutDrawn.slots.map((s) => ({ ...s, ...z(s) })), card: loadoutDrawn.card && z(loadoutDrawn.card) };
};

/** The text that fits `maxW`, cut with an ellipsis if it must be. */
function fitted(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** The level chip: "LV" and the number, gold, stamping larger for a moment when it climbs. */
function levelChip(ctx: CanvasRenderingContext2D, x: number, cy: number, level: number, now: number): number {
  const pop = popOf(now - vfx.levelAt, 380);
  setFont(ctx, 700, TYPE.micro);
  const lw = ctx.measureText('LV').width;
  setFont(ctx, 850, TYPE.body);
  const nw = ctx.measureText(String(level)).width;
  const w = lw + nw + 4;
  const sc = 1 + 0.35 * pop * pop;
  ctx.translate(x + w / 2, cy);
  ctx.scale(sc, sc);
  text(ctx, 'LV', -w / 2, 0.5, TYPE.micro, PANEL_MUTED, 'left', 700);
  text(ctx, String(level), -w / 2 + lw + 4, 0.5, TYPE.body, pop > 0 ? mixHex(PALETTE.gold, '#fff6c8', pop) : PALETTE.gold, 'left', 850);
  ctx.scale(1 / sc, 1 / sc);
  ctx.translate(-x - w / 2, -cy);
  return w;
}

/** The progress line on its plate: the level, then what is next and how far ("Next: Perk · 520 / 700") over a thin bar. */
function drawRankLine(ctx: CanvasRenderingContext2D, x: number, y: number, prog: Progress, now: number): Rect {
  const pad = 10;
  setFont(ctx, 700, TYPE.micro);
  const lvW = ctx.measureText('LV').width + 4 + (setFont(ctx, 850, TYPE.body), ctx.measureText(String(prog.level)).width);
  const [head, rest] = prog.pick ? ['', prog.text] : prog.next ? ['Next:', prog.text.slice('Next: '.length)] : ['Score', prog.text.slice('Score '.length)];
  setFont(ctx, 700, TYPE.label);
  const headW = head ? ctx.measureText(head).width + 5 : 0;
  setFont(ctx, 800, TYPE.label);
  const restW = ctx.measureText(rest).width;
  const w = pad + lvW + RANK.gap + headW + restW + pad;
  celPlate(ctx, x, y, w, RANK.h);
  const cy = y + (prog.next ? RANK.h / 2 - 2 : RANK.h / 2);
  if (vfx.levelBurst) { vfx.levelBurst = false; if (!REDUCED) burst(x + pad + lvW / 2, cy, 14, PALETTE.gold, 70, now, 5); }
  levelChip(ctx, x + pad, cy, prog.level, now);
  const tx = x + pad + lvW + RANK.gap;
  ctx.fillStyle = 'rgba(236, 230, 214, 0.16)';
  ctx.fillRect(tx - RANK.gap / 2 - 1, y + 6, 2, RANK.h - 12);
  if (head) text(ctx, head, tx, cy + 0.5, TYPE.label, PANEL_MUTED, 'left', 700);
  text(ctx, rest, tx + headW, cy + 0.5, TYPE.label, prog.pick ? PALETTE.gold : PANEL_INK, 'left', 800);
  if (prog.next) bar(ctx, tx, y + RANK.h - 6, headW + restW, RANK.bar, prog.frac, PALETTE.gold, 'rgba(236, 230, 214, 0.14)');
  return { x, y, w, h: RANK.h + 3 };
}

/** One tile: a cel plate with the item's icon (the gun's art for the gun) over its short name; the ability's carries its cooldown. */
function drawSlot(ctx: CanvasRenderingContext2D, b: SlotBox, slot: LoadoutSlot, me: PlayerView, self: SelfView, now: number, pop: number, hover: boolean) {
  const t = performance.now();
  const ability = slot.kind === 'ability' && self.ability !== null;
  const ready = ability && self.abilityReadyIn <= 0;
  const cooling = ability && !ready;
  const shake = cooling && t - abilityDeniedAt < ABILITY_CUE.deniedMs ? deniedShake(t) : 0;
  const cx = b.x + b.w / 2 + shake;
  const iconCy = b.y + (b.h - SLOT_LABEL_H) / 2 + 2;
  const sc = pop > 0 ? 0.55 + 0.45 * easeOutBack(1 - pop) : 1;
  if (sc !== 1) { ctx.save(); ctx.translate(cx, b.y + b.h / 2); ctx.scale(sc, sc); ctx.translate(-cx, -b.y - b.h / 2); ctx.globalAlpha = Math.min(1, (1 - pop) * 3); }
  if (ready && !REDUCED) {
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * (0.3 + 0.3 * (0.5 + 0.5 * Math.sin(now / 420)));
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.roundRect(b.x - 5 + shake, b.y - 5, b.w + 10, b.h + 12, 8);
    ctx.fill();
    ctx.globalAlpha = a0;
  }
  const face = ready ? ACCENT : hover ? '#4a515c' : undefined;
  celPlate(ctx, b.x + shake, b.y, b.w, b.h, face);
  // The name, on a dark well along the bottom of the tile.
  ctx.fillStyle = ready ? 'rgba(28, 31, 38, 0.32)' : 'rgba(14, 16, 21, 0.45)';
  ctx.fillRect(b.x + shake + 2, b.y + b.h - SLOT_LABEL_H, b.w - 4 - Math.min(PANEL_CUT, b.h / 3) / 2, SLOT_LABEL_H - 2);
  setFont(ctx, 800, TYPE.label);
  text(ctx, fitted(ctx, slot.label, b.w - 8), cx, b.y + b.h - SLOT_LABEL_H / 2 - 0.5, TYPE.label, ready ? CEL.ink : PANEL_INK, 'center', 800);
  if (slot.gun) {
    drawGunArt(ctx, slot.gun, b.x + 7 + shake, iconCy - 11, b.w - 14, 22, { align: 'center', golden: me.golden === true, skin: me.cos?.g });
    // Its evolution as gold pips in the top-left corner: one for stage 1, two for stage 2.
    for (let i = 0; i < GUNS[slot.gun].stage; i++) {
      ctx.fillStyle = PALETTE.gold;
      ctx.strokeStyle = CEL.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(b.x + 9 + i * 9, b.y + 5);
      ctx.lineTo(b.x + 13 + i * 9, b.y + 9);
      ctx.lineTo(b.x + 9 + i * 9, b.y + 13);
      ctx.lineTo(b.x + 5 + i * 9, b.y + 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Zombies: the gun's scrap bounty as a small gold chip in the top-right corner ("+30%").
    if (slot.bounty) {
      setFont(ctx, 800, TYPE.micro);
      const tw = ctx.measureText(slot.bounty).width + 8, bx = b.x + shake + b.w - tw - 4;
      cel(ctx, bx, b.y + 3, tw, 14, '#2f343d', 4, 1.5);
      text(ctx, slot.bounty, bx + tw / 2, b.y + 10.5, TYPE.micro, slot.bounty.startsWith('+') ? PALETTE.gold : PANEL_INK, 'center', 800);
    }
  } else if (slot.perk) {
    strokeIcon(ctx, PERK_ICONS[slot.perk], cx, iconCy, 24, ready ? CEL.ink : cooling ? 'rgba(236, 230, 214, 0.45)' : PANEL_INK, 2.6);
  }
  if (cooling) {
    // The wedge still to wait covers the icon, shrinking clockwise as the cooldown runs, with the seconds over it.
    const left = Math.max(0, Math.min(1, self.abilityReadyIn / abilityCooldownMs(self.ability!, self.perks ?? {})));
    const r = Math.min(b.w, b.h - SLOT_LABEL_H) / 2 - 3;
    ctx.fillStyle = 'rgba(14, 16, 21, 0.62)';
    ctx.beginPath();
    ctx.moveTo(cx, iconCy);
    ctx.arc(cx, iconCy, r, -Math.PI / 2 + (1 - left) * TAU, -Math.PI / 2 + TAU);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(236, 230, 214, 0.22)';
    ctx.beginPath();
    ctx.arc(cx, iconCy, r, 0, TAU);
    ctx.stroke();
    outlined(ctx, (self.abilityReadyIn / 1000).toFixed(self.abilityReadyIn >= 10000 ? 0 : 1), cx, iconCy + 1, TYPE.body, PANEL_INK, 800);
  }
  // Its key, as a keycap on the tile's top edge: lit when it can be pressed.
  if (ability && !touchScreen) {
    setFont(ctx, 800, TYPE.micro);
    const kw = ctx.measureText('SPACE').width + 10;
    cel(ctx, cx - kw / 2, b.y - 9, kw, 15, ready ? '#ece6d6' : '#2f343d', 4, 2);
    text(ctx, 'SPACE', cx, b.y - 1.5, TYPE.micro, ready ? CEL.ink : PANEL_MUTED, 'center', 800);
  }
  const back = (t - abilityBackAt) / ABILITY_CUE.readyPulseMs;
  if (ready && back >= 0 && back < 1 && !REDUCED) {
    if (vfx.abilitySpark !== abilityBackAt) { vfx.abilitySpark = abilityBackAt; burst(cx, iconCy, 9, PALETTE.gold, 34, t, 4.5); }
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * (1 - back);
    ctx.lineWidth = 3;
    ctx.strokeStyle = PALETTE.gold;
    ctx.beginPath();
    ctx.roundRect(b.x - 3 - back * 8, b.y - 3 - back * 8, b.w + 6 + back * 16, b.h + 6 + back * 16, 6);
    ctx.stroke();
    ctx.globalAlpha = a0;
  }
  if (sc !== 1) { ctx.restore(); hudFont = ''; }
}

/** Words wrapped to `maxW` at the current font. */
function wrap(ctx: CanvasRenderingContext2D, s: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The hover card under the strip: the item's name, what kind of pick it is, and what it does. */
function drawSlotCard(ctx: CanvasRenderingContext2D, slot: LoadoutSlot, x: number, y: number, maxX: number): Rect {
  const w = 248, pad = 10, lineH = 18;
  setFont(ctx, 600, TYPE.label);
  const lines = wrap(ctx, slot.desc, w - pad * 2);
  const h = pad + 20 + 17 + lines.length * lineH + pad - 4;
  const cx = Math.max(EDGE, Math.min(x, maxX - w));
  celPlate(ctx, cx, y, w, h);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(cx, y, 3, h - Math.min(PANEL_CUT, h / 3));
  text(ctx, slot.name, cx + pad, y + pad + 9, TYPE.title, PANEL_INK, 'left', 800);
  text(ctx, slot.kindLabel, cx + pad, y + pad + 27, TYPE.micro, slot.kind === 'gun' && slot.gun && GUNS[slot.gun].stage === 2 ? PALETTE.hunted : PALETTE.gold, 'left', 700);
  lines.forEach((l, i) => text(ctx, l, cx + pad, y + pad + 46 + i * lineH, TYPE.label, '#cfc7b3', 'left', 600));
  return { x: cx, y, w, h: h + 5 };
}

/** What the strip draws this frame, and when each tile first showed (for its stamp-in), reset with each life. */
function seenSlots(me: PlayerView, slots: readonly LoadoutSlot[], boxes: readonly SlotBox[], now: number, dt: number): SeenSlot[] {
  // Tiles already there on the first frame drawn for this player (a page joined mid-life) are not new: they show without a stamp.
  const fresh = slotsLife !== me.id;
  if (fresh) slotsSeen.clear();
  slotsLife = me.id;
  const keep = new Set(slots.map((s) => s.key));
  for (const key of [...slotsSeen.keys()]) if (!keep.has(key)) slotsSeen.delete(key);
  return slots.map((s, i) => {
    const b = boxes[i]!;
    let seen = slotsSeen.get(s.key);
    if (!seen) slotsSeen.set(s.key, (seen = { born: fresh ? -1e9 : now, x: b.x, sparked: fresh }));
    seen.x = REDUCED || Math.abs(seen.x - b.x) < 0.5 ? b.x : seen.x + (b.x - seen.x) * (1 - Math.exp(-dt / 90));
    return seen;
  });
}

/**
 * The desktop strip at (`x`, `y`): the progress line, then the tiles under it. Returns the strip's bottom, where the status tabs
 * go. On the range, which has no level ladder, only the tiles show.
 */
type StripEnd = { bottom: number; beside: { x: number; y: number }[]; card?: () => void };
function drawLoadout(hud: Hud, x: number, y: number, compact: boolean): StripEnd {
  const { ctx, snap, me, now, dt, w } = hud;
  const self = snap.self;
  loadoutDrawn = { rank: null, slots: [], card: null };
  if (!me) return { bottom: y, beside: [{ x, y: y + RANK.h / 2 }] };
  let top = y;
  const beside: { x: number; y: number }[] = [];
  if (!snap.range) {
    const r = drawRankLine(ctx, x, y, progressLine(me.level, vfx.shownScore, self.pending), now);
    loadoutDrawn.rank = r;
    panels.push(r);
    top = y + r.h + (compact ? 9 : 11);
    beside.push({ x: r.x + r.w + 10, y: y + RANK.h / 2 });
  }
  const slots = loadoutSlots(me.gun, self.perks ?? {}, self.ability, touchScreen ? '' : 'Space', !!snap.run);
  if (!slots.length) { slotsSeen.clear(); slotsLife = me.id; return { bottom: loadoutDrawn.rank ? top - 6 : y, beside: beside.length ? beside : [{ x, y: y + RANK.h / 2 }] }; }
  const boxes = slotBoxes(slots, x, top, compact);
  const seen = seenSlots(me, slots, boxes, now, dt);
  let hovered: number | null = null;
  slots.forEach((slot, i) => {
    const b = { ...boxes[i]!, x: seen[i]!.x };
    const age = now - seen[i]!.born;
    const pop = popOf(age, SLOT_POP_MS);
    if (pop > 0 && !seen[i]!.sparked) { seen[i]!.sparked = true; burst(b.x + b.w / 2, b.y + b.h / 2, 12, PALETTE.gold, 70, now, 4.5); }
    const hover = !touchScreen && !spreadOff && inside(hudCrosshair, b);
    if (hover) hovered = i;
    drawSlot(ctx, b, slot, me, self, now, pop, hover);
    loadoutDrawn.slots.push({ ...b, kind: slot.kind, label: slot.label, name: slot.name });
    panels.push({ x: b.x - 2, y: b.y - (slot.kind === 'ability' ? 10 : 0), w: b.w + 5, h: b.h + 8 });
  });
  const last = boxes.at(-1)!;
  const bottom = top + last.h + 6;
  beside.push({ x: last.x + last.w + 10, y: top + last.h / 2 });
  // The hover card is drawn last, over the status tabs (drawVitals calls it).
  const hov: number | null = hovered;
  const card = hov === null ? undefined : () => { loadoutDrawn.card = drawSlotCard(ctx, slots[hov]!, boxes[hov]!.x, bottom + 6, w - EDGE); panels.push(loadoutDrawn.card); };
  return { bottom, beside, card };
}

/** The phone's level row beside the cross, on demand: the level, a pin for each picked attachment and perk, and the score where no board chip shows it. */
function drawPhoneRank(hud: Hud, x: number, cy: number, maxX: number, showScore: boolean): number {
  const { ctx, snap, me, now } = hud;
  if (!me) return 0;
  const prog = progressLine(me.level, vfx.shownScore, snap.self.pending);
  if (vfx.levelBurst) { vfx.levelBurst = false; if (!REDUCED) burst(x + 14, cy, 12, PALETTE.gold, 60, now, 4.5); }
  setFont(ctx, 700, TYPE.micro);
  const lw = ctx.measureText('LV').width + 4 + (setFont(ctx, 850, TYPE.body), ctx.measureText(String(prog.level)).width) + 14;
  cel(ctx, x, cy - 11, lw, 22, '#2f343d', 5, 2);
  levelChip(ctx, x + 7, cy, prog.level, now);
  let px = x + lw + 6;
  const picks = loadoutSlots(me.gun, snap.self.perks ?? {}, null).filter((s) => s.kind === 'attachment' || s.kind === 'perk');
  const seen = seenSlots(me, picks, picks.map(() => ({ x: 0, y: 0, w: 0, h: 0 })), now, hud.dt);
  picks.forEach((s, i) => {
    if (px + 24 > maxX) return;
    const pop = popOf(now - seen[i]!.born, SLOT_POP_MS);
    const r = 11 * (pop > 0 ? 0.55 + 0.45 * easeOutBack(1 - pop) : 1);
    pin(ctx, px + 11, cy - 1, r, '#4c535f');
    strokeIcon(ctx, PERK_ICONS[s.perk!], px + 11, cy - 1, 14 * (r / 11), PANEL_INK, 2.4);
    px += 28;
  });
  if (showScore) {
    const score = String(Math.round(vfx.shownScore));
    setFont(ctx, 800, TYPE.body);
    if (px + ctx.measureText(score).width <= maxX) { inked(ctx, score, px + 2, cy + 1, TYPE.body, PALETTE.gold, 800); px += ctx.measureText(score).width + 6; }
  }
  return px - x;
}

/** A kill put `n` rounds back in your mag: the magazine lights them and a "+n" rises off the count (see topup.ts). */
export function noteTopup(n: number, now: number) { vfx.topN = n; vfx.topAt = now; }
const TOPUP_HUD_MS = 900;

/**
 * The ammo readout beside the reticle: a small inked count over a thin strip of round ticks (a plain fill bar for big mags), so it can be read
 * in a glance without sitting on the fight. Reloading turns the strip into a gold progress bar.
 */
function drawAmmoCluster(ctx: CanvasRenderingContext2D, x: number, y: number, self: SelfView, now: number, left = false) {
  const low = self.ammo <= Math.max(1, Math.round(self.mag * 0.25));
  const empty = self.ammo === 0;
  const throb = low && !REDUCED ? 0.5 + 0.5 * Math.sin(now / (empty ? 140 : 240)) : 0;
  const reloading = self.reloading;
  const tone = reloading ? PALETTE.gold : empty ? AMMO.empty : low ? AMMO.liveLow : AMMO.live;
  const label = reloading ? 'RELOAD' : String(self.ammo);
  const numSize = reloading ? 12 : 20;
  setFont(ctx, 800, numSize);
  const numW = ctx.measureText(label).width;
  const sub = reloading ? '' : `/${self.mag}`;
  setFont(ctx, 700, 11);
  const subW = sub ? ctx.measureText(sub).width + 3 : 0;
  const stripW = 44;
  const total = Math.max(stripW, numW + subW);
  const x0 = left ? x - total : x;
  const pop = reloading ? 0 : popOf(now - vfx.ammoAt, 190);
  const sc = 1 + 0.18 * pop * pop;
  const ink = reloading ? PALETTE.gold : empty ? mixHex(PALETTE.hpBad, '#ffffff', throb * 0.4) : low ? mixHex(ACCENT, '#ffffff', throb * 0.35) : PANEL_INK;
  const ny = y + 10;
  ctx.translate(x0, ny);
  ctx.scale(sc, sc);
  inked(ctx, label, 0, 0, numSize, ink, 800);
  ctx.scale(1 / sc, 1 / sc);
  ctx.translate(-x0, -ny);
  if (sub) inked(ctx, sub, x0 + numW + 3, ny + 3, 11, low ? AMMO.liveLow : PANEL_INK, 700);
  // The strip: one tick per round for small mags, a fill bar past that; rounds a kill just put back glow and a "+n" rises off the count.
  const top = reloading ? 0 : popOf(now - vfx.topAt, TOPUP_HUD_MS);
  const sy = y + 21, sh = 4;
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.roundRect(x0 - 1, sy - 1, stripW + 2, sh + 2, 2);
  ctx.fill();
  ctx.fillStyle = '#262a32';
  ctx.fillRect(x0, sy, stripW, sh);
  if (reloading) {
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(x0, sy, stripW * Math.max(0, Math.min(1, self.reloadFrac)), sh);
  } else if (self.mag <= 30) {
    const g = 1, rw = (stripW - g * (self.mag - 1)) / self.mag;
    for (let i = 0; i < self.ammo; i++) {
      ctx.fillStyle = top > 0 && i >= self.ammo - vfx.topN ? mixHex(tone, '#fff6c8', Math.min(1, top * 1.3)) : tone;
      ctx.fillRect(x0 + i * (rw + g), sy, rw, sh);
    }
  } else {
    ctx.fillStyle = tone;
    ctx.fillRect(x0, sy, (stripW * self.ammo) / self.mag, sh);
  }
  if (top > 0) {
    ctx.globalAlpha = Math.min(1, top * 2.2);
    inked(ctx, `+${vfx.topN}`, x0 + total + 4, ny - 10 * (1 - top), 13, PALETTE.gold, 800);
    ctx.globalAlpha = 1;
  }
}

/** Armor's colours: the steel-blue pool, its empty groove, and the grey a spent armor turns. */
const ARMOR = { fill: '#8fb8ff', track: '#262a32', empty: '#6b717c' } as const;

/** The share of a full armor pool `p` has left (the view's `ap` byte; absent is full), 0 with no armor. */
export const armorFrac = (p: Pick<PlayerView, 'armorTier' | 'ap'>): number => (p.armorTier === 'none' ? 0 : (p.ap ?? 255) / 255);

/**
 * Armor as a thin arc just outside the health ring, on the same centre (your drawn soldier, so it keeps the ring's alignment): steel blue
 * for the pool left, a dark groove for what is spent, all grey once it is empty. A pack's refill flashes it pale.
 */
function drawArmorRing(hud: Hud, frac: number) {
  const { ctx, selfAt, cam, now } = hud;
  const R = WORLD.playerRadius * cam.scale + 9 + 5.5;
  const a0 = -Math.PI / 2, up = popOf(now - vfx.armorUpAt, 420);
  ctx.lineCap = 'butt';
  ctx.lineWidth = 4;
  ctx.strokeStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(selfAt.x, selfAt.y, R, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = frac <= 0 ? ARMOR.empty : ARMOR.track;
  ctx.beginPath();
  ctx.arc(selfAt.x, selfAt.y, R, 0, TAU);
  ctx.stroke();
  if (frac <= 0) return;
  ctx.strokeStyle = up > 0 ? mixHex(ARMOR.fill, '#f2f7ff', up * 0.9) : ARMOR.fill;
  ctx.lineWidth = 2 + up * 1.5;
  ctx.beginPath();
  ctx.arc(selfAt.x, selfAt.y, R, a0, a0 + TAU * frac);
  ctx.stroke();
}

/** Health as a thin segmented ring round your soldier while hurt: a glance-cue where your eyes already are; the cross holds the figure. */
function drawHpRing(hud: Hud, me: PlayerView, frac: number, tone: string) {
  const { ctx, selfAt, cam, now } = hud;
  const R = WORLD.playerRadius * cam.scale + 9;
  const n = Math.max(4, Math.min(8, Math.ceil(me.maxHp / 100)));
  const gap = 0.22, span = TAU / n - gap;
  const hurt = popOf(now - vfx.hurtAt, 260);
  const lit = hurt > 0 ? mixHex(tone, '#fff1d2', hurt * 0.8) : tone;
  ctx.lineCap = 'butt';
  for (const [width, color] of [[5, CEL.ink], [2.5, '#262a32']] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * (TAU / n) + gap / 2;
      ctx.beginPath();
      ctx.arc(selfAt.x, selfAt.y, R, a0, a0 + span);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 2.5;
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * (TAU / n) + gap / 2;
    const f = Math.max(0, Math.min(1, frac * n - i)), t = Math.max(0, Math.min(1, vfx.trail * n - i));
    if (t > f + 0.004) {
      ctx.strokeStyle = now < vfx.hold || REDUCED ? '#fff1d2' : '#f2c27a';
      ctx.beginPath();
      ctx.arc(selfAt.x, selfAt.y, R, a0 + span * f, a0 + span * t);
      ctx.stroke();
    }
    if (f <= 0) continue;
    ctx.strokeStyle = lit;
    ctx.beginPath();
    ctx.arc(selfAt.x, selfAt.y, R, a0, a0 + span * f);
    ctx.stroke();
  }
}

/**
 * The vitals: the health cross bottom left (top left on a touch screen, where the move stick owns the bottom left), the ability
 * medal and rank pins top left, the ammo count beside the reticle (your soldier's side on a touch screen, which has no cursor),
 * and a thin health ring round your soldier while hurt or low.
 */
function drawVitals(hud: Hud, compact: boolean) {
  const { ctx, snap, me, w, h, now, selfAt, cam } = hud;
  if (!me) return;
  const self = snap.self;
  const ins = inset();
  const P = hud.P;
  const X0 = P ? P.vitals.x : EDGE + ins.l, Y0 = P ? P.vitals.y : EDGE + ins.t;
  vitalsAt.x = X0;
  vitalsAt.y = Y0;
  const lp = levelProgress(me.level, me.score);
  stepVitals(hud, me, self, lp.displayLevel, lp.frac);
  const look = healthLook(me.hp, me.maxHp, vfx.shownHp, now, vfx.hurtAt, vfx.healAt);
  const lowHp = look.state === 'low' || look.state === 'critical';
  // The ring: full while low, otherwise a few seconds after a hit, fading out.
  const sinceHurt = now - vfx.hurtAt;
  const ringA = lowHp ? 1 : REDUCED ? (sinceHurt < 2400 ? 1 : 0) : Math.max(0, Math.min(1, (3000 - sinceHurt) / 700));
  if (ringA > 0.01) {
    ctx.globalAlpha = ringA * 0.85;
    drawHpRing(hud, me, look.frac, look.tone);
    ctx.globalAlpha = 1;
  }
  // The armor arc rides with the health ring, and on its own for a few seconds after the pool wears or refills; spent, it stays up grey.
  const armor = armorFrac(me);
  if (me.armorTier !== 'none') {
    const sinceArmor = now - vfx.armorAt;
    const armorA = Math.max(ringA, armor <= 0 ? 0.7 : REDUCED ? (sinceArmor < 2400 ? 1 : 0) : Math.max(0, Math.min(1, (3000 - sinceArmor) / 700)));
    if (armorA > 0.01) {
      ctx.globalAlpha = armorA * 0.85;
      drawArmorRing(hud, armor);
      ctx.globalAlpha = 1;
    }
  }
  // The health cross, with the armor chip and the health statuses (shield, rush) beside it.
  const S = P ? HEALTH.phoneSize : compact || touchScreen ? HEALTH.compactSize : HEALTH.size;
  const bx = X0, by = touchScreen ? Y0 : h - EDGE - ins.b - S;
  const shield = me.spawnShield ? 'spawn' : me.shield ? 'perk' : null;
  drawHealthCross(ctx, bx, by, S, look, colorHexOf(snap, me.id, me.team), shield, now);
  panels.push({ x: bx - 6, y: by - 6, w: S + 12, h: S + 12 });
  const tier = ARMOR_IDS.indexOf(me.armorTier);
  const healthTabs: [string, string, string][] = [];
  if (shield) healthTabs.push([shield === 'spawn' ? 'SPAWN' : 'SHIELD', STATUS.shield, PERK_ICONS.shield]);
  if (me.rush) healthTabs.push(self.perks[2] === 'secondWind' ? ['WIND', STATUS.rush, PERK_ICONS.secondWind] : ['RUSH', STATUS.rush, PERK_ICONS.adrenaline]);
  // The corner kit: on a desktop the loadout strip top left (the progress line, then a tile per pick); beside the cross on a
  // touch screen. On a phone the ability lives on its touch button, so the kit beside the small cross is just the level and the
  // picked perks as pins, and only for a moment after the level or score changes (or a tap on the cross: phonefocus.ts); the
  // tabs then take its row.
  const kitX = P ? X0 + S + 12 : touchScreen ? X0 + S + 16 : X0;
  const rowY = P ? Y0 + 13 : Y0 + 22;
  const rank = !P || !hud.F || hud.F.level || hud.F.score;
  let rows: { x: number; y: number }[];
  let card: (() => void) | undefined;
  if (P) {
    if (rank) {
      const kitW = drawPhoneRank(hud, kitX, rowY, P.vitals.x + P.vitals.w, !hud.F?.board);
      panels.push({ x: kitX, y: rowY - 14, w: kitW, h: 28 });
    }
    rows = [{ x: kitX, y: rank ? rowY + 26 : rowY }];
  } else {
    const strip = drawLoadout(hud, kitX, Y0, compact || touchScreen);
    card = strip.card;
    // Tabs while in effect: under the strip on a desktop; to its right on a touch screen, where the minimap sits under it.
    rows = touchScreen ? strip.beside : Array.from({ length: 4 }, (_, i) => ({ x: kitX, y: strip.bottom + 14 + i * 24 }));
  }
  let row = 0;
  let cx = rows[0]!.x;
  let sy = rows[0]!.y;
  // Each tab goes on the row, wrapping before it would reach `limit`: on a phone, the vitals box's edge (one row only; the rest wait).
  const limit = P ? P.vitals.x + P.vitals.w : touchScreen ? w / 2 - Math.min(360, 0.44 * w * hudScale) / 2 / hudScale - 6 : Infinity;
  const put = (width: number, draw: (x: number, y: number) => void) => {
    if (cx > rows[row]!.x && cx + width > limit) {
      if (row + 1 >= rows.length) return;
      row++;
      cx = rows[row]!.x;
      sy = rows[row]!.y;
      if (cx + width > limit) return;
    }
    draw(cx, sy);
    cx += width + 6;
  };
  const tabWidth = (label: string) => { setFont(ctx, 800, TYPE.micro); return ctx.measureText(label).width + 29; };
  if (touchScreen) {
    // A phone shows the armor chip only once the pool is short: a full one says nothing the ring does not.
    if (tier > 0 && (!P || armor < 1)) put(50, (x, y) => drawArmorChip(ctx, x, y, tier, armor, now));
    for (const [label, color, icon] of healthTabs) put(tabWidth(label), (x, y) => statusTab(ctx, x, y, label, color, icon));
  } else {
    const sx = bx + S + 8;
    let ty = by + S / 2;
    if (drawArmorChip(ctx, sx, ty, tier, armor, now) > 0) ty -= 26;
    for (const [label, color, icon] of healthTabs) { statusTab(ctx, sx, ty, label, color, icon); ty -= 24; }
  }
  // A phone keeps the tabs that warn (hunted); the sprint ring lights on the stick itself and streaks have their callout.
  if (self.sprint === true && !P) put(tabWidth('SPRINT'), (x, y) => statusTab(ctx, x, y, 'SPRINT', STATUS.sprint, PERK_ICONS.marathon));
  if (me.hunted) put(huntedBadgeWidth(ctx), (x, y) => drawHuntedBadge(ctx, x, y));
  if (self.streak >= 2 && !P) put(streakBadgeWidth(ctx, self.streak), (x, y) => drawStreakBadge(ctx, x, y, self.streak, now));
  // A phone shows the ammo count on its reload button (touchbuttons.ts), off the fight.
  if (P) { drawSparks(ctx, now); return; }
  // Ammo: beside the reticle, or your soldier on a touch screen; mirrored when it would run off the right edge.
  const near = touchScreen || spreadOff;
  const reach = WORLD.playerRadius * cam.scale;
  const gap = Math.max(reticleDrawnGap, 10) + RETICLE.tick;
  const cw = 64, ch = 28;
  const hx = near ? selfAt.x : hudCrosshair.x, hy = near ? selfAt.y : hudCrosshair.y;
  const dx = near ? reach + 16 : gap * 0.7 + 14;
  const dy = near ? -8 : gap * 0.5 + 6;
  // Beside the reticle on its lower right; mirrored or lifted if that would sit on a panel or off the screen.
  const spots: [number, number, boolean][] = [[hx + dx, hy + dy, false], [hx - dx, hy + dy, true], [hx + dx, hy - dy - ch, false], [hx - dx, hy - dy - ch, true]];
  const free = ([sx, sy, mirrored]: [number, number, boolean]) => {
    const r0 = { x: mirrored ? sx - cw : sx, y: Math.min(h - ch - 8, Math.max(EDGE, sy)), w: cw, h: ch };
    return r0.x > 4 && r0.x + cw < w - 4 && !panels.some((q) => r0.x < q.x + q.w && r0.x + r0.w > q.x && r0.y < q.y + q.h && r0.y + r0.h > q.y);
  };
  const [fx, fy, flip] = spots.find(free) ?? spots[0]!;
  drawAmmoCluster(ctx, fx, Math.min(h - ch - 8, Math.max(EDGE, fy)), self, now, flip);
  // The hover card over everything in the corner, the ammo count included: the cursor is on the strip, not the fight.
  card?.();
  drawSparks(ctx, now);
}
let spreadOff = false;


/* ---------------------------------------------------------------------------------------------------------------------------
 * Toy-box scoreboard and feed: soldiers are drawn as helmet tokens in their own colour, scores as big numbers, the team race as
 * a tug-of-war bar, the clock as a stopwatch tag, and your own lines as ribbons. Names stay, but small; everything else is icons.
 * ------------------------------------------------------------------------------------------------------------------------- */
const STREAK_FLAME = '#ff7a2f';
const seenColor = new Map<number, ColorId>();
const seenFlags = new Map<number, { streak: number; hunted: boolean }>();
const COLOR_LIST = Object.keys(COLORS) as ColorId[];

/** The players in view this frame: the board and feed colour a helmet, and show flames and marks, for anyone the camera has met. */
function rememberPlayers(snap: Snapshot) {
  for (const p of snap.players) {
    seenColor.set(p.id, p.color);
    seenFlags.set(p.id, { streak: p.streak ?? 0, hunted: p.hunted });
  }
  if (seenColor.size > 400) { seenColor.clear(); seenFlags.clear(); }
}

/** A soldier's colour: their team in team modes, else the colour last seen on them, else a stable guess from their id. */
function colorHexOf(snap: Snapshot, id: number | null, team: Team): string {
  if (team && !snap.run) return COLORS[team];
  const seen = id === null ? undefined : seenColor.get(id);
  return COLORS[seen ?? COLOR_LIST[Math.abs(id ?? 0) % COLOR_LIST.length]!];
}

/** A soldier's head from above as a token: ink ring, a lit dome with a darker lower edge, a rim line, a specular dot. */
function helmet(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, hex: string) {
  ctx.fillStyle = CEL.shadow;
  ctx.beginPath();
  ctx.arc(cx + 1.5, cy + 2.5, r + 1.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.8, 0, TAU);
  ctx.fill();
  ctx.fillStyle = shade(hex, 0.68);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.arc(cx - r * 0.1, cy - r * 0.14, r * 0.86, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = shade(hex, 0.62);
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.52, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.38, cy - r * 0.42, Math.max(1, r * 0.2), 0, TAU);
  ctx.fill();
}

/** Your own line: a ribbon with a swallowtail on its left end, a lit top band and an ink edge. */
function ribbon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) {
  const tail = Math.min(7, h / 3);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + tail, y + h / 2);
  ctx.closePath();
  ctx.fillStyle = CEL.shadow;
  ctx.save();
  ctx.translate(2, 3);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillRect(x, y, w, Math.max(3, h * 0.28));
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = CEL.ink;
  ctx.stroke();
}

/** A name that shrinks to fit rather than running into the figures beside it. */
function fitName(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight: number, maxW: number) {
  setFont(ctx, weight, size);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y + 1, Math.max(10, maxW));
}

/** The clock as a stopwatch tag: a pin with the dial, the time, and a slow orange throb through the last 30 seconds. */
function drawTimerToken(hud: Hud, y: number, ms: number, live: boolean, fade = true): number {
  const { ctx, w, now } = hud;
  const urgent = live && ms > 0 && ms <= 30000;
  const label = clock(ms);
  setFont(ctx, 800, TYPE.title);
  const tw = ctx.measureText(label).width;
  const pw = tw + 44, ph = 26, x = w / 2 - pw / 2;
  if (fade) fadePanel(hud, 'score', x, y, pw, ph);
  const beat = urgent && !REDUCED ? 0.5 + 0.5 * Math.sin((now * TAU) / 1000) : urgent ? 1 : 0;
  panel(ctx, x, y, pw, ph, urgent ? mixHex(CEL.body, '#a63a12', 0.55 + 0.3 * beat) : undefined);
  pin(ctx, x + 19, y + 12, 8, urgent ? ACCENT : '#4c535f');
  strokeIcon(ctx, UI_ICONS.clock, x + 19, y + 12, 12, urgent ? CEL.ink : PANEL_INK, 2.6);
  text(ctx, label, x + 34 + tw / 2, y + 14, TYPE.title, urgent ? mixHex(PANEL_INK, '#ffd0a8', beat) : PANEL_INK, 'center', 800);
  return y + ph;
}

/**
 * One DOM point on the objective strip: an enamel pin in its owner's colour that the taker's colour fills like a clock as the
 * capture runs, a thin flag beside it at the height the world flag flies, pips for the soldiers taking it (faster with more),
 * a two-colour flash while it is contested, and a bar under the one you stand on.
 */
function drawZonePin(ctx: CanvasRenderingContext2D, zx: number, zy: number, r: number, z: ZoneView, letter: string, now: number, on: boolean) {
  const shake = z.contested && !REDUCED ? Math.sin(now / 30) * 1.2 : 0;
  zx += shake;
  pin(ctx, zx, zy, r, z.owner ? COLORS[z.owner] : '#6c7380');
  if (z.capturing && z.progress > 0.01) {
    ctx.fillStyle = COLORS[z.capturing];
    ctx.beginPath();
    ctx.moveTo(zx, zy);
    ctx.arc(zx, zy, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, z.progress) * TAU);
    ctx.closePath();
    ctx.fill();
  }
  text(ctx, letter, zx, zy + 1, TYPE.label, z.owner || (z.capturing && z.progress > 0.5) ? CEL.ink : PANEL_INK, 'center', 800);
  // The outer progress ring, or the contested flash.
  const ring = r + 5;
  ctx.lineWidth = 4;
  ctx.strokeStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(zx, zy, ring, 0, TAU);
  ctx.stroke();
  if (z.contested) {
    const flip = Math.floor(now / 180) % 2;
    for (let q = 0; q < 8; q++) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = (q + flip) % 2 ? COLORS.red : COLORS.blue;
      ctx.beginPath();
      ctx.arc(zx, zy, ring, (q / 8) * TAU, ((q + 0.8) / 8) * TAU);
      ctx.stroke();
    }
  } else if (z.capturing && z.progress > 0.01) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS[z.capturing];
    ctx.beginPath();
    ctx.arc(zx, zy, ring, -Math.PI / 2, -Math.PI / 2 + Math.min(1, z.progress) * TAU);
    ctx.stroke();
  }
  // A thin flag up the pin's right: its colour and height match the world flag.
  const flag = flagOf(z), px = zx + r + 9, top = zy - r - 3, foot = zy + r + 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = CEL.ink;
  ctx.beginPath();
  ctx.moveTo(px, foot);
  ctx.lineTo(px, top - 1);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#c9ccd3';
  ctx.stroke();
  const fy = foot - 7 - (foot - 7 - top) * flag.height;
  ctx.fillStyle = CEL.ink;
  ctx.fillRect(px, fy - 1, 9, 8);
  ctx.fillStyle = flag.team ? COLORS[flag.team] : '#e9e4d6';
  ctx.fillRect(px + 1, fy, 7, 6);
  // Pips under the pin for the crew working it: one per soldier, capped where the rate caps.
  if (z.crew && !z.contested) {
    const n = Math.min(4, z.crew), hex = z.capturing ? COLORS[z.capturing] : PANEL_INK;
    for (let q = 0; q < n; q++) {
      const qx = zx + (q - (n - 1) / 2) * 7, qy = zy + ring + 6;
      ctx.fillStyle = CEL.ink;
      ctx.beginPath();
      ctx.arc(qx, qy, 3.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.arc(qx, qy, 2, 0, TAU);
      ctx.fill();
    }
  }
  if (on) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(zx - 7, zy - ring - 7, 14, 3);
  }
}

/**
 * Edge arrows to the points your team is working off screen: your team's colour toward one it is taking, and a pulsing alarm
 * toward one of yours being taken or contested. Each carries the point's letter.
 */
function drawZoneArrows({ ctx, w, h, snap, now, cam, selfAt, me }: Hud) {
  const team = me?.team;
  if (snap.match.mode !== 'DOM' || !team) return;
  const zs = [...snap.zones].sort((a, b) => a.id - b.id);
  const pulse = 0.5 + 0.5 * Math.sin(now / 130);
  zs.forEach((z, i) => {
    const taking = z.capturing === team && z.progress > 0.02 && !z.contested;
    const losing = z.owner === team && ((z.capturing !== null && z.capturing !== team && z.progress > 0.02) || z.contested === true);
    if (!taking && !losing) return;
    const at = edgePoint(selfAt, worldToScreen(cam, z), w, h, EDGE_INSET + 6);
    if (!at) return;
    const clear = clearOfRects(selfAt, at, panels, ARROW_CLEARANCE);
    const color = losing ? PALETTE.hunted : COLORS[team];
    ctx.save();
    ctx.translate(clear.x, clear.y);
    ctx.rotate(at.angle);
    ctx.scale(losing ? 1.15 + 0.15 * pulse : 1.05, losing ? 1.15 + 0.15 * pulse : 1.05);
    ctx.globalAlpha = losing ? 0.75 + 0.25 * pulse : 0.9;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -12);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 12);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = CEL.ink;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    const lx = clear.x - Math.cos(at.angle) * 26, ly = clear.y - Math.sin(at.angle) * 26;
    pin(ctx, lx, ly, 10, z.owner ? COLORS[z.owner] : '#6c7380');
    if (z.capturing && z.progress > 0.01) {
      ctx.fillStyle = COLORS[z.capturing];
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.arc(lx, ly, 10, -Math.PI / 2, -Math.PI / 2 + Math.min(1, z.progress) * TAU);
      ctx.closePath();
      ctx.fill();
    }
    text(ctx, zoneLetter(i), lx, ly + 1, TYPE.label, CEL.ink, 'center', 800);
    ctx.globalAlpha = 1;
  });
}

/** TDM and DOM: each team's score at its end of a tug-of-war bar that fills toward the win line, with the clock tag under it and, in DOM, a pin for each zone. */
function drawTeamBanner(hud: Hud, y: number, compact: boolean, left: number | null): number {
  const { ctx, w, snap, me, now } = hud;
  const dom = snap.match.mode === 'DOM';
  const target = dom ? WORLD.domWinScore : WORLD.tdmWinScore;
  const bw = compact ? 236 : 300, ph = compact ? 30 : 36, x = w / 2 - bw / 2, cy = y + ph / 2;
  fadePanel(hud, 'score', x, y, bw, ph);
  panel(ctx, x, y, bw, ph);
  const big = compact ? 18 : 22;
  const scoreW = compact ? 36 : 44;
  const bx = x + 30 + scoreW, bwid = bw - (30 + scoreW) * 2, half = bwid / 2;
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.roundRect(bx - 2, cy - 8, bwid + 4, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#262a32';
  ctx.fillRect(bx, cy - 6, bwid, 12);
  for (const [team, side] of [['red', -1], ['blue', 1]] as const) {
    const score = snap.match.teamScore[team];
    const frac = Math.max(0, Math.min(1, score / target));
    const hex = COLORS[team];
    const hx = side < 0 ? x + 17 : x + bw - 17;
    helmet(ctx, hx, cy - 1, 9, hex);
    if (me?.team === team) { ctx.fillStyle = ACCENT; ctx.fillRect(hx - 7, y + ph - 6, 14, 3); }
    text(ctx, String(score), side < 0 ? x + 31 : x + bw - 31, cy + 1, big, FEED_TEAM[team], side < 0 ? 'left' : 'right', 800);
    const fw = Math.max(score > 0 ? 3 : 0, half * frac);
    const fx = side < 0 ? bx : bx + bwid - fw;
    ctx.fillStyle = hex;
    ctx.fillRect(fx, cy - 6, fw, 12);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(fx, cy - 6, fw, 4);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(fx, cy + 3, fw, 3);
  }
  ctx.fillStyle = '#ece6d6';
  ctx.fillRect(bx + half - 1, cy - 9, 2, 18);
  let bottom = y + ph;
  // A phone carries the clock and the zones in its slim top line instead (drawPhoneLine).
  if (hud.P) return bottom;
  if (left !== null) bottom = drawTimerToken(hud, y + ph + 4, left, true, false);
  if (dom && snap.zones.length) {
    const zs = [...snap.zones].sort((a, b) => a.id - b.id);
    const r = 12, step = 48, zy = bottom + 8 + r + 4;
    // A plate behind the pins so they read over any floor, neon or night.
    panel(ctx, w / 2 - (zs.length * step) / 2 - 2, zy - r - 11, zs.length * step + 8, 2 * r + 26);
    zs.forEach((z, i) => {
      const zx = w / 2 + (i - (zs.length - 1) / 2) * step;
      const on = me?.alive === true && Math.hypot(me.x - z.x, me.y - z.y) <= z.r;
      drawZonePin(ctx, zx, zy, r, z, zoneLetter(i), now, on);
    });
    bottom = zy + r + 16;
  }
  return bottom;
}


/* ---------------------------------------------------------------------------------------------------------------------------
 * The phone on its side (phonelayout.ts): the same kit, condensed into the corners so nothing sits on the fight. The scoreboard
 * folds to a chip (your place and score) that a tap opens for a few seconds; banners and callouts flash for two seconds in one
 * slim line under the clock chip, which then goes back to the mode's own status; hints and the downed plate keep to one line low
 * between the sticks.
 * ------------------------------------------------------------------------------------------------------------------------- */
const PHONE = { boardOpenMs: 3000, calloutMs: 2000, introMs: 2600, fadeMs: 260 } as const;
let phoneShown: PhoneLayout | null = null;
const boardChip = { rect: null as Rect | null, openUntil: 0 };
/** Whether the board chip was drawn last frame (it is left out in co-op and on the range), so a tap there is the chip's. */
let boardShown = false;

/** The phone layout in HUD units (the HUD draws at 1 / scale), or null when this is not a phone on its side. */
function phoneBoxes(w: number, h: number, k: number): PhoneLayout | null {
  if (!isPhoneLandscape(w, h, touchScreen)) { phoneShown = null; return null; }
  const css = phoneLayout(w, h, safe, k);
  const out = {} as Record<string, Box>;
  for (const [key, b] of Object.entries(css)) out[key] = { x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k };
  phoneShown = out as PhoneLayout;
  return phoneShown;
}

/** Dev probe: the phone layout's boxes as drawn last frame, in CSS px, or null off a phone. */
export const drawnPhoneLayout = (): PhoneLayout | null => phoneShown && (Object.fromEntries(Object.entries(phoneShown).map(([key, b]) => [key, { x: b.x * hudScale, y: b.y * hudScale, w: b.w * hudScale, h: b.h * hudScale }])) as PhoneLayout);

/**
 * A tap at (sx, sy) CSS px on the phone HUD's canvas parts: the scoreboard chip opens the full board for a few seconds (or folds
 * it), the minimap opens big for a few seconds (or folds), and the health cross brings up the level and score chips. True when it
 * took the tap, so no stick starts under it.
 */
export function phoneBoardTap(sx: number, sy: number, now: number): boolean {
  if (!phoneShown) return false;
  const x = sx / hudScale, y = sy / hudScale, slack = 8;
  const hit = (r: Box | null) => !!r && x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack;
  if (boardShown && hit(boardChip.rect)) {
    boardChip.openUntil = now < boardChip.openUntil ? 0 : now + PHONE.boardOpenMs;
    return true;
  }
  const map = now - phoneTaps.map < FOCUS.mapOpenMs ? phoneShown.minimapOpen : phoneShown.minimap;
  if (hit(map)) { phoneTaps.map = now - phoneTaps.map < FOCUS.mapOpenMs ? -Infinity : now; return true; }
  if (hit(phoneShown.vitals)) { phoneTaps.vitals = now; return true; }
  return false;
}

/** The folded scoreboard: your helmet, your place and your score, with a caret that says it opens. Returns the bottom of what it drew. */
function drawBoardChip(hud: Hud, P: PhoneLayout, full: boolean): number {
  const { ctx, snap, s, me, now } = hud;
  const b = P.board;
  boardShown = true;
  boardChip.rect = b;
  if (full || now < boardChip.openUntil) {
    // Open, it drops from the chip down to the reload button, as many rows as fit (your own row always among them).
    const top = b.y + b.h + 6;
    return drawLeaderboard(hud, true, true, { right: P.cog.x + P.cog.w, top, rows: Math.max(3, Math.floor((P.reload.y - 6 - top - BOARD.pad * 2 - 22 - 5) / BOARD.row)) });
  }
  const rows = boardRows(snap.leaderboard, s.myId, null);
  const mine = rows.find((r) => r.row.id === s.myId);
  fadePanel(hud, 'board', b.x, b.y, b.w, b.h);
  panel(ctx, b.x, b.y, b.w, b.h);
  const cy = b.y + b.h / 2;
  const teams = snap.match.mode === 'TDM' || snap.match.mode === 'DOM' || snap.match.mode === 'BR';
  helmet(ctx, b.x + 15, cy - 1, 7.5, colorHexOf(snap, s.myId, teams ? me?.team ?? null : null));
  text(ctx, mine ? `#${mine.place}` : '–', b.x + 28, cy, TYPE.title, PANEL_INK, 'left', 800);
  text(ctx, String(mine?.row.kills ?? 0), b.x + b.w - 24, cy, TYPE.title, PALETTE.gold, 'right', 800);
  ctx.fillStyle = PANEL_MUTED;
  ctx.beginPath();
  ctx.moveTo(b.x + b.w - 17, cy - 2);
  ctx.lineTo(b.x + b.w - 9, cy - 2);
  ctx.lineTo(b.x + b.w - 13, cy + 3);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  return b.y + b.h;
}

/** One line on a plate, title in its colour and the rest in ink, cut with an ellipsis to fit `maxW`; fades in and out over `life`. */
function phoneLine(ctx: CanvasRenderingContext2D, title: string, line: string, color: string, box: Box, age: number, life: number) {
  const fade = Math.max(0, Math.min(1, age / 120, (life - age) / PHONE.fadeMs));
  if (fade <= 0) return;
  setFont(ctx, 800, TYPE.label + 1, true);
  const tw = title ? ctx.measureText(title).width + 8 : 0;
  setFont(ctx, 650, TYPE.label);
  let rest = line;
  const room = box.w - 20 - tw;
  if (ctx.measureText(rest).width > room) {
    while (rest.length > 1 && ctx.measureText(`${rest}…`).width > room) rest = rest.slice(0, -1);
    rest = `${rest.trimEnd()}…`;
  }
  const pw = Math.min(box.w, tw + ctx.measureText(rest).width + 20), x = box.x + box.w / 2 - pw / 2, cy = box.y + box.h / 2;
  ctx.globalAlpha = fade;
  panel(ctx, x, box.y, pw, box.h);
  ctx.fillStyle = color;
  ctx.fillRect(x, box.y + box.h - 2, pw - PANEL_CUT, 2);
  if (title) {
    setFont(ctx, 800, TYPE.label + 1, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(title, x + 10, cy + 1);
  }
  text(ctx, rest, x + 10 + tw, cy + 1, TYPE.label, PANEL_INK, 'left', 650);
  ctx.globalAlpha = 1;
}

/** The phone's focus memory: what changed when (level, score, team score), what a thumb tapped, and which modes' objective line
 * this device has already read (kept, so it is spelled out once per mode: phonefocus.ts). */
const focusSeen = { key: '', level: 0, score: 0, team: '', levelAt: -Infinity, scoreAt: -Infinity, teamAt: -Infinity };
const phoneTaps = { vitals: -Infinity, map: -Infinity };
const INTRO_KEY = 'skirmish.phoneIntro';
const introModes = new Set<string>((() => { try { return (localStorage.getItem(INTRO_KEY) ?? '').split(',').filter(Boolean); } catch { return []; } })());
/** The mode whose objective line this match spells out (decided at the round's start, so it plays out in full). */
const introNow = { key: '', show: false };

function focusOf(hud: Hud): Record<PhoneElement, boolean> {
  const { snap, me, now, s } = hud;
  const key = `${snap.match.mode}|${snap.match.map}|${s.myId}`;
  const level = me?.level ?? focusSeen.level, score = me?.score ?? focusSeen.score;
  const team = `${snap.match.teamScore.red}:${snap.match.teamScore.blue}`;
  if (key !== focusSeen.key) Object.assign(focusSeen, { key, level, score, team, levelAt: -Infinity, scoreAt: -Infinity, teamAt: -Infinity });
  if (level !== focusSeen.level) Object.assign(focusSeen, { level, levelAt: now });
  if (score !== focusSeen.score) Object.assign(focusSeen, { score, scoreAt: now });
  if (team !== focusSeen.team) Object.assign(focusSeen, { team, teamAt: now });
  const dom = phoneDomState();
  const F = phoneFocus({
    mode: snap.match.mode, now, timeLeft: snap.run || snap.royale || snap.range ? null : timeLeft(hud),
    over: snap.match.winner !== null || snap.run?.phase === 'over', squadsLeft: snap.royale?.squads.filter((q) => q.place === null).length,
    levelAt: focusSeen.levelAt, scoreAt: focusSeen.scoreAt, vitalsTapAt: phoneTaps.vitals, teamScoreAt: focusSeen.teamAt,
    mapTapAt: phoneTaps.map, chatTapAt: dom.chatTapAt, rangeTapAt: dom.rangeTapAt, chatLines: dom.chatLines,
    firstMatch: labelsSeen.first, guidesSince: guideClock.since, introSeen: introModes.has(snap.match.mode),
  });
  syncPhoneFocus(F);
  return F;
}

/** The phone's top centre: the mode's status line where it has one (or TDM's score after it moves, or the clock in a round's last
 * minute), and under it a brief line. Returns the bottom of the two rows. */
function drawPhoneTop(hud: Hud, P: PhoneLayout, F: Record<PhoneElement, boolean>): number {
  const left = timeLeft(hud);
  if (F.status) drawPhoneStatus(hud, P.topChip);
  else if (F.teamScore) drawTeamBanner(hud, P.topChip.y, true, left);
  else if (F.clock) drawTimerToken(hud, P.topChip.y, left ?? 0, true, false);
  // TDM's last minute shows its score above and the clock in the brief line, when no callout holds it.
  if (!drawPhoneLine(hud, P, F) && F.teamScore && F.clock) drawTimerToken(hud, P.topLine.y, left ?? 0, true, false);
  return P.topLine.y + P.topLine.h;
}

type Seg = { w: number; draw: (x: number) => void };
/** Segments in one plate across `box`, shrunk to fit its width; each draws at its left edge on the row's centre line (y 0). */
function statusRow(ctx: CanvasRenderingContext2D, box: Box, segs: Seg[], fill?: string) {
  const gap = 12, pad = 10;
  const total = segs.reduce((a, g) => a + g.w, 0) + gap * (segs.length - 1);
  const k = Math.min(1, (box.w - pad * 2) / total);
  const pw = total * k + pad * 2, x = box.x + box.w / 2 - pw / 2;
  panel(ctx, x, box.y, pw, box.h, fill);
  ctx.save();
  ctx.translate(x + pad, box.y + box.h / 2);
  ctx.scale(k, k);
  let at = 0;
  for (const g of segs) { g.draw(at); at += g.w + gap; }
  ctx.restore();
}
const widthOf = (ctx: CanvasRenderingContext2D, s: string, size: number, weight: number) => { setFont(ctx, weight, size); return ctx.measureText(s).width; };

/**
 * The phone's one status line, for the modes that need one always: Domination's two scores round its zones (and the clock in the
 * last minute), the zombies run's day or night with what is left of it, the core and the survivors (and the scrap by day, when it
 * buys walls and turrets), and Last Squad's ring with the squads still standing.
 */
function drawPhoneStatus(hud: Hud, box: Box) {
  const { ctx, snap, s, now, me } = hud;
  const segs: Seg[] = [];
  if (snap.run) {
    const run = snap.run;
    const [label, color] = run.phase === 'day' ? [`DAY ${run.night}`, PALETTE.gold] : run.phase === 'night' ? [`NIGHT ${run.night}`, '#a99bff'] : run.report?.won ? ['HELD', PALETTE.hpGood] : ['FALLEN', PALETTE.hunted];
    const until = run.phaseEndsAt === null ? null : run.phaseEndsAt - (serverNow(s.snaps, now) ?? run.phaseEndsAt);
    const center = run.phase === 'night' ? `${run.waveLeft} left` : until === null ? '' : clock(until);
    const lw = widthOf(ctx, label, TYPE.label + 1, 800), cw = center ? widthOf(ctx, center, TYPE.body, 650) : 0;
    segs.push({ w: lw + (cw ? 8 + cw : 0), draw: (x) => { text(ctx, label, x, 1, TYPE.label + 1, color, 'left', 800); if (cw) text(ctx, center, x + lw + 8, 1, TYPE.body, PANEL_INK, 'left', 650); } });
    if (run.phase !== 'over') {
      const frac = run.core.hp / run.core.maxHp;
      const alert = now - s.coreHitAt < CORE_ALERT_MS;
      const coreColor = alert && Math.floor(now / 200) % 2 ? PALETTE.hunted : frac > 0.5 ? PALETTE.hpGood : frac > 0.25 ? PALETTE.gold : PALETTE.hpBad;
      if (run.phase === 'day') {
        const sw = widthOf(ctx, `${run.scrap}`, TYPE.body, 750);
        segs.push({ w: 15 + sw, draw: (x) => { strokeIcon(ctx, UI_ICONS.scrap, x + 5, 0, 12, PALETTE.gold, 2.2); text(ctx, `${run.scrap}`, x + 15, 1, TYPE.body, PANEL_INK, 'left', 750); } });
      }
      segs.push({ w: 15 + 48, draw: (x) => { strokeIcon(ctx, UI_ICONS.core, x + 5, 0, 12, coreColor, 2.2); bar(ctx, x + 15, -3, 48, 6, frac, coreColor, 'rgba(255, 255, 255, 0.18)'); } });
      const people = `${run.survivors}`, mourned = run.phase === 'night' && run.lost > 0 ? `−${run.lost}` : '';
      const pw = widthOf(ctx, people, TYPE.body, 750), uw = widthOf(ctx, 'survivors', TYPE.micro, 500), mw = mourned ? widthOf(ctx, mourned, TYPE.label, 700) + 6 : 0;
      segs.push({ w: pw + 4 + uw + mw, draw: (x) => {
        text(ctx, people, x, 1, TYPE.body, alert ? coreColor : PANEL_INK, 'left', 750);
        text(ctx, 'survivors', x + pw + 4, 1, TYPE.micro, PANEL_MUTED, 'left', 500);
        if (mourned) text(ctx, mourned, x + pw + 4 + uw + 6, 1, TYPE.label, PALETTE.lossOnDark, 'left', 700);
      } });
    }
    return statusRow(ctx, box, segs);
  }
  if (snap.royale) {
    const royale = snap.royale;
    const pill = ringPill(royale, serverNow(s.snaps, now) ?? royale.ring.shrinkAt);
    const lw = widthOf(ctx, pill.label, TYPE.label + 1, 800), tw = pill.time ? widthOf(ctx, pill.time, TYPE.body, 650) : 0;
    segs.push({ w: lw + (tw ? 8 + tw : 0), draw: (x) => { text(ctx, pill.label, x, 1, TYPE.label + 1, '#c9b3ff', 'left', 800); if (tw) text(ctx, pill.time, x + lw + 8, 1, TYPE.body, PANEL_INK, 'left', 650); } });
    const size = trackerSize(royale.squads.length), kt = Math.min(1, (box.h - 4) / size.h);
    segs.push({ w: size.w * kt, draw: (x) => { ctx.save(); ctx.translate(x, (-size.h * kt) / 2); ctx.scale(kt, kt); drawTracker(ctx, royale, me?.team ?? null, 0, 0); ctx.restore(); } });
    if (!royale.redeploys) {
      const ll = 'LAST LIVES', llw = widthOf(ctx, ll, TYPE.micro, 800);
      segs.push({ w: llw, draw: (x) => text(ctx, ll, x, 1, TYPE.micro, PALETTE.lossOnDark, 'left', 800) });
    }
    return statusRow(ctx, box, segs);
  }
  if (snap.match.mode === 'DOM') {
    const left = timeLeft(hud);
    const urgent = left !== null && left > 0 && left <= FOCUS.clockMs;
    const score = (team: 'red' | 'blue', side: -1 | 1): Seg => {
      const n = String(snap.match.teamScore[team]), nw = widthOf(ctx, n, TYPE.title, 800);
      return { w: 20 + nw, draw: (x) => {
        const hx = side < 0 ? x + 8 : x + nw + 12;
        helmet(ctx, hx, -1, 8, COLORS[team]);
        if (me?.team === team) { ctx.fillStyle = ACCENT; ctx.fillRect(hx - 6, box.h / 2 - 5, 12, 3); }
        text(ctx, n, side < 0 ? x + 20 : x, 1, TYPE.title, FEED_TEAM[team], 'left', 800);
      } };
    };
    segs.push(score('red', -1));
    const zs = [...snap.zones].sort((a, b) => a.id - b.id);
    const PIN = { k: 0.56, step: 28 } as const;
    if (zs.length) segs.push({ w: zs.length * PIN.step - 6, draw: (x) => zs.forEach((z, i) => {
      const on = !!me?.alive && Math.hypot(me.x - z.x, me.y - z.y) <= z.r;
      ctx.save();
      ctx.translate(x + PIN.step * i + 11, 0);
      ctx.scale(PIN.k, PIN.k);
      drawZonePin(ctx, 0, 0, 12, z, zoneLetter(i), now, on);
      ctx.restore();
    }) });
    if (urgent) {
      const label = clock(left), cw = widthOf(ctx, label, TYPE.body, 800);
      segs.push({ w: 16 + cw, draw: (x) => { strokeIcon(ctx, UI_ICONS.clock, x + 6, 0, 11, ACCENT, 2.4); text(ctx, label, x + 16, 1, TYPE.body, PANEL_INK, 'left', 800); } });
    }
    segs.push(score('blue', 1));
    return statusRow(ctx, box, segs, urgent ? mixHex(CEL.body, '#a63a12', 0.6) : undefined);
  }
}

/**
 * The brief line under the phone's status: a callout (night falls, a streak) for two seconds, the round's objective once per mode
 * on this device, or the next map's notice near a round's end. True when it drew.
 */
function drawPhoneLine(hud: Hud, P: PhoneLayout, F: Record<PhoneElement, boolean>): boolean {
  const { ctx, snap, s, now, me } = hud;
  const box = P.topLine;
  const c = [...s.moments.callouts].reverse().find((x) => now - x.born >= 0 && now - x.born < PHONE.calloutMs);
  if (c) { phoneLine(ctx, c.title, c.line, c.color, box, now - c.born, PHONE.calloutMs); return true; }
  if (!me) return false;
  const key = `${snap.match.mode}|${snap.match.map}`;
  if (objectiveSeen.key !== key) {
    objectiveSeen.key = key;
    objectiveSeen.at = now;
    introNow.show = F.intro;
    if (F.intro) {
      introModes.add(snap.match.mode);
      try { localStorage.setItem(INTRO_KEY, [...introModes].join(',')); } catch { /* a private window forgets */ }
    }
  }
  const intro = now - objectiveSeen.at;
  if (introNow.show && intro < PHONE.introMs) {
    phoneLine(ctx, snap.match.map, objectiveFor(snap.match.mode, me.team, timeLeft(hud)).line, me.team && !snap.run ? TEAM_COLORS[me.team] : ACCENT, box, intro, PHONE.introMs);
    if (intro < PHONE.introMs - PHONE.fadeMs) return true;
  }
  const notice = mapNotice(snap.match);
  if (notice) { phoneLine(ctx, '', notice, PALETTE.gold, box, 1e6, 2e6); return true; }
  return false;
}

/** One line low between the sticks (hints, the revive prompt), unless the level-up pill holds that spot. */
function phoneBottom(hud: Hud, P: PhoneLayout, line: string, color: string, accent: string | null = ACCENT) {
  if (hud.snap.self.pending) return;
  platedLine(hud.ctx, line, P.bottom.x + P.bottom.w / 2, P.bottom.y + P.bottom.h / 2, TYPE.label + 1, color, 750, accent);
}

/** You're down, on a phone: the plate's title and time on one line, with the revive bar under it. */
function drawPhoneDowned(hud: Hud, P: PhoneLayout, downed: NonNullable<PlayerView['downed']>) {
  const { ctx, s, now } = hud;
  const cx = P.bottom.x + P.bottom.w / 2, cy = P.bottom.y + P.bottom.h / 2 - 2;
  platedLine(ctx, `You're down · ${downedLine(downed, serverNow(s.snaps, now))}`, cx, cy, TYPE.label + 1, PALETTE.hunted, 800, PALETTE.hunted);
  ctx.globalAlpha = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 260));
  bar(ctx, cx - 60, cy + 13, 120, 4, downed.revive, PALETTE.hpGood, ON_PANEL.track);
  ctx.globalAlpha = 1;
}

/** The siege on a phone: its status rides the top line (drawPhoneLine), so this keeps the core's arrow, your downed plate and the use prompt. */
function drawPhoneSiege(hud: Hud, P: PhoneLayout, run: NonNullable<Snapshot['run']>) {
  const { ctx, w, s, me, now, cam, selfAt, h } = hud;
  if (now - s.coreHitAt < CORE_ALERT_MS) {
    const at = edgePoint(selfAt, worldToScreen(cam, run.core), w, h, EDGE_INSET + 10);
    if (at) {
      const clear = clearOfRects(selfAt, at, panels, ARROW_CLEARANCE);
      edgeArrow(ctx, clear, at.angle, 1.1, 1);
      strokeIcon(ctx, UI_ICONS.core, clear.x - Math.cos(at.angle) * 22, clear.y - Math.sin(at.angle) * 22, 14, PALETTE.hunted, 2.4);
    }
  }
  if (run.phase === 'over') return;
  if (me?.downed) return drawPhoneDowned(hud, P, me.downed);
  if (!me?.alive) return;
  // Build mode needs a keyboard (B), so its bars only come up on a phone with one attached; they keep to the bottom.
  if (s.building) {
    const row = P.bottom.y + P.bottom.h / 2;
    const rows = buildRows();
    rows.forEach((r, i) => hintBar(ctx, s, r.chips, w / 2, row - 30 * (rows.length - i), r.label));
    hintBar(ctx, s, BUILD_CONTROLS, w / 2, row, 'BUILD');
    return;
  }
  const use = useHint(hud.snap, s.lastSelf);
  if (use) phoneBottom(hud, P, use, PALETTE.gold);
}

/** Last Squad on a phone: the tracker rides the top line; this keeps your downed plate, the revive prompt and who you watch. */
function drawPhoneRoyale(hud: Hud, P: PhoneLayout, royale: NonNullable<Snapshot['royale']>) {
  const { snap, s, me, now } = hud;
  if (me?.downed) return drawPhoneDowned(hud, P, me.downed);
  const revive = reviveHint(snap, me);
  if (revive) return phoneBottom(hud, P, revive, PALETTE.gold);
  if (me?.alive) return;
  const clockNow = serverNow(s.snaps, now);
  if (clockNow === null) return;
  phoneBottom(hud, P, spectateLines(snap, royale, clockNow).title, PANEL_INK);
}
