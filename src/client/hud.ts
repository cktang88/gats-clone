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
import { BUILD_CONTROLS, buildRows, downedLine, forecast, phaseLine, readyHint, squadShare, upgradeTarget, useHint, type BuildChip, type HintChip } from './zombies.ts';
import { airdropLine, drawAirdropMap } from './arenafx.ts';
import { drawRingMap, drawTracker, reviveHint, ringLine, ringPill, spectateLines, squadLabel, trackerSize } from './royale.ts';
import { drawGunArt, skinInk } from './gunart.ts';
import { drawFlashOverlay } from './flashsmoke.ts';
import type { Session } from './state.ts';
import { uiScaleFor } from './uiscale.ts';
import { crosshairLook } from './settings.ts';

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

type Hud = { ctx: CanvasRenderingContext2D; w: number; h: number; snap: Snapshot; s: Session; me: PlayerView | null; now: number; dt: number; cam: Camera; selfAt: Point; on: OnWorld };

const GUN_BY_NAME = new Map<string, GunId>(GUN_IDS.map((id) => [GUNS[id].name, id]));
const PERK_BY_NAME = new Map<string, PerkId>(Object.entries(PERK_INFO).map(([id, info]) => [info.name, id as PerkId]));

/**
 * Where an idle stick's guide ring sits, in px in from its bottom-left (move) or bottom-right (aim) corner, where the touch buttons arc above it (style.css),
 * and how faint it is before and after the player has first used that stick.
 */
const STICK_GUIDE = { inset: 96, aimRight: 150, alpha: 0.24, usedAlpha: 0.1 } as const;
const sticksUsed = { move: false, aim: false };

/** Touch screens draw a faint ring where each stick goes while no thumb is on it, so players know the sticks are there. */
function drawStickGuides(ctx: CanvasRenderingContext2D, sticks: Sticks, w: number, h: number) {
  const guides = [
    { key: 'move', active: sticks.move, x: STICK_GUIDE.inset + safe.l, label: 'MOVE' },
    { key: 'aim', active: sticks.aim, x: w - STICK_GUIDE.aimRight - safe.r, label: 'AIM · FIRE' },
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
    ctx.font = '700 15px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.label, g.x, y + STICK_RADIUS + 12);
  }
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

export function drawHud(ctx: CanvasRenderingContext2D, dpr: number, screenCam: Camera, snap: Snapshot, s: Session, now: number, screenCrosshair: Point, spread: number | null, fullBoard = false) {
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
  const hud: Hud = { ctx, w, h, snap, s, me, now, dt: Math.min(100, Math.max(0, now - lastHudAt)), cam, selfAt: worldToScreen(cam, s.lastSelf), on };
  lastHudAt = now;
  rememberPlayers(snap);
  hudCrosshair = crosshair;
  spreadOff = spread === null;
  panels = [];
  buildChips = [];
  const compact = w < 640 || h < 520 || k < 1;
  drawSuppression(hud);
  drawFlashOverlay(ctx, w, h, snap.self.flash ?? 0, now);
  drawHurtVignette(hud);
  drawHurtArcs(hud);
  const boardBottom = drawLeaderboard(hud, compact, fullBoard);
  drawMinimap(hud, compact ? 96 : 160);
  const below = drawPill(hud, compact);
  // On a phone the right column is the leaderboard above the thumbs' buttons, so a short feed (two rows) goes top centre under the timer.
  if (touchScreen && compact) drawKillFeed(hud, below + SPACE.sm, 2, w / 2 + 120);
  else drawKillFeed(hud, boardBottom + SPACE.sm, compact ? 3 : 5);
  ctx.globalAlpha = 1;
  const siegeTop = drawObjectiveLine(hud, below, fullBoard);
  if (me?.alive) drawVitals(hud, compact);
  if (snap.run) drawSiege(hud, snap.run, siegeTop, compact);
  if (snap.royale) drawRoyale(hud, snap.royale, siegeTop);
  drawHuntedArrows(hud);
  drawZoneArrows(hud);
  drawScorePopups(hud);
  drawCallouts(hud);
  trackAbility(snap.self, now);
  stepRaise(hud);
  if (spread !== null) drawReticle(hud, crosshair, spread);
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

function drawCallouts({ ctx, w, h, s, now, selfAt }: Hud) {
  let row = 0;
  for (const c of s.moments.callouts) {
    const age = now - c.born;
    if (age < 0 || age >= CALLOUT_MS) continue;
    if (c.ring && age < RING_MS) drawRingBurst(ctx, selfAt, c.color, age);
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
function drawKillFeed(hud: Hud, top: number, rows: number, rightEdge?: number) {
  const { ctx, w, s, now } = hud;
  const lines = s.feed.filter((f) => now - f.at < FEED_MS).slice(-rows);
  const right = rightEdge ?? w - EDGE - inset().r;
  const drawRow = (f: (typeof lines)[number], i: number) => {
    const y = top + i * FEED_ROW + 10;
    ctx.globalAlpha = Math.min(1, (FEED_MS - (now - f.at)) / 600) * 0.95;
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
}

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

function drawLeaderboard(hud: Hud, compact: boolean, full: boolean): number {
  const { ctx, w, h, snap, s, me } = hud;
  const rows = boardRows(snap.leaderboard, s.myId, full ? (compact || h < 760 ? 6 : 12) : null, touchScreen && compact ? BOARD.touchTop : undefined);
  const teams = snap.match.mode === 'TDM' || snap.match.mode === 'DOM' || snap.match.mode === 'BR';
  const ffaTarget = snap.match.mode === 'FFA' ? WORLD.ffaWinKills : 0;
  const pw = compact ? BOARD.compactW : BOARD.w;
  const x = w - pw - EDGE - inset().r, top = EDGE + inset().t;
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
    const icons = (flags?.hunted ? 1 : 0) + (flags && flags.streak >= 2 ? 1 : 0);
    const scoreW = 26;
    const nameMax = pw - (nx - x) - BOARD.pad - scoreW - icons * 22;
    fitName(ctx, mine ? 'you' : r.name, nx, y - 1, TYPE.body, color, weight, nameMax);
    let ix = x + pw - BOARD.pad - scoreW - 4;
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
  const x0 = touchScreen ? EDGE + inset().l : w - EDGE - inset().r - size - pad * 2, y0 = touchScreen ? EDGE + inset().t + VITALS.height + 8 : h - EDGE - inset().b - size - pad * 2;
  const base = fadePanel(hud, 'minimap', x0, y0, size + pad * 2, size + pad * 2);
  panel(ctx, x0, y0, size + pad * 2, size + pad * 2, MINIMAP.bg);
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
    ctx.fillStyle = m.team ? TEAM_COLORS[m.team] : '#ff6b5f';
    ctx.beginPath();
    ctx.arc(x + m.x * k, y + m.y * k, 2.5, 0, TAU);
    ctx.fill();
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
    const lines = [ringLine(snap.royale, clockNow), ...(snap.royale.redeploys ? [] : ['Last lives'])];
    lines.forEach((line, i) => platedLine(ctx, line, x0 + (size + pad * 2) / 2, y0 - 16 - (lines.length - 1 - i) * 28, TYPE.label + 1, i === 0 ? PANEL_INK : PALETTE.lossOnDark, 700));
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
  const ph = compact ? 24 : 28, y = EDGE + inset().t;
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
  } else if (run.phase === 'day') {
    hintBar(ctx, s, [{ key: 'B', what: 'build walls, turrets and more' }, { key: 'N', what: readyHint(run, hud.snap.players, hud.snap.self.id) }], w / 2, row, null);
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
  id: -1, at: -1e9, hp: 0, shownHp: 0, trail: 1, hold: 0, hurtAt: -1e9, healAt: -1e9,
  ammo: 0, ammoAt: -1e9, topN: 0, topAt: -1e9, level: 0, levelAt: -1e9, shownFrac: 0, shownScore: 0, streak: 0, streakAt: -1e9, abilitySpark: -1, levelBurst: false,
};

function stepVitals({ dt, now }: Hud, me: PlayerView, self: SelfView, displayLevel: number, frac: number) {
  const hpFrac = me.hp / me.maxHp;
  const fresh = vfx.id !== me.id || now - vfx.at > 400;
  vfx.id = me.id;
  vfx.at = now;
  if (fresh) {
    Object.assign(vfx, { hp: me.hp, shownHp: me.hp, trail: hpFrac, ammo: self.ammo, level: displayLevel, shownFrac: frac, shownScore: me.score, streak: self.streak, hurtAt: -1e9, healAt: -1e9 });
    sparks = [];
    return;
  }
  if (me.hp < vfx.hp - 0.5) { vfx.hurtAt = now; vfx.hold = now + 360; vfx.trail = Math.max(vfx.trail, vfx.hp / me.maxHp); }
  else if (me.hp > vfx.hp + 0.5) vfx.healAt = now;
  vfx.hp = me.hp;
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
export const HEALTH = { size: 104, compactSize: 84, arm: 0.48, figure: 46, compactFigure: 38, low: 0.35, critical: 0.15, flashMs: 280, healMs: 480 } as const;
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
  const size = (s === HEALTH.size ? HEALTH.figure : HEALTH.compactFigure) * (1 + 0.12 * look.flash);
  const ink = look.heal > 0 ? mixHex('#ffffff', HEAL, look.heal) : look.state === 'critical' || look.state === 'low' ? mixHex('#ffffff', '#ffb3b3', look.pulse) : '#ffffff';
  inked(ctx, look.figure, x + s / 2, y + s / 2 + 1, size, ink, 800, 'center');
}

/** The armor worn as a small shield chip with a pip per tier (light, medium, heavy). Returns its width, 0 when none is worn. */
function drawArmorChip(ctx: CanvasRenderingContext2D, x: number, cy: number, tier: number): number {
  if (tier <= 0) return 0;
  const w = 50;
  cel(ctx, x, cy - 10, w, 20, '#3d4450', 4, 2);
  fillIcon(ctx, PERK_ICONS.shield, x + 12, cy, 14, PANEL_INK);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < tier ? PANEL_INK : 'rgba(236, 230, 214, 0.2)';
    ctx.fillRect(x + 23 + i * 8, cy - 5, 5, 10);
  }
  return w;
}

/** The level as a ring badge: the ring fills with XP toward the next level. */
function drawLevelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, level: number, frac: number, pop: number) {
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(cx, cy, 13, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#2a2f38';
  ctx.beginPath();
  ctx.arc(cx, cy, 10.5, 0, TAU);
  ctx.stroke();
  if (frac > 0.01) {
    ctx.strokeStyle = PALETTE.gold;
    ctx.beginPath();
    ctx.arc(cx, cy, 10.5, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * TAU);
    ctx.stroke();
  }
  ctx.fillStyle = '#3d4450';
  ctx.beginPath();
  ctx.arc(cx, cy, 8.5, 0, TAU);
  ctx.fill();
  text(ctx, String(level), cx, cy + 1, level > 9 ? 12 : 14, pop > 0 ? mixHex(PANEL_INK, PALETTE.gold, pop) : PANEL_INK, 'center', 800);
}

type SelfView = Snapshot['self'];

/** The ability as a medallion: its icon on a lit face, a radial sweep while it cools, READY with a glow and the key once it is up, a lock before it is earned. */
function drawAbility(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, self: SelfView, now: number, opts: { side?: boolean; ribbon?: boolean } = {}) {
  const t = performance.now();
  const ready = self.ability !== null && self.abilityReadyIn <= 0;
  const cooling = self.ability !== null && !ready;
  const pick = self.ability === null && self.pending?.k === 'perk' && self.pending.tier === ABILITY_TIER;
  const left = cooling ? Math.max(0, Math.min(1, self.abilityReadyIn / abilityCooldownMs(self.ability!, self.perks ?? {}))) : 0;
  const denied = cooling && t - abilityDeniedAt < ABILITY_CUE.deniedMs;
  const cx = x + deniedShake(t);
  const lip = 4;
  const face = ready ? ACCENT : pick ? PALETTE.gold : denied ? PALETTE.hpBad : '#4c535f';
  if (ready && !REDUCED) {
    ctx.globalAlpha = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(now / 420));
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.arc(cx, y + 1, r + 6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (opts.ribbon) {
    for (const [sx, ink] of [[-1, '#a63a12'], [1, '#d9d1bd']] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * 3, y + r - 4);
      ctx.lineTo(cx + sx * 14, y + r - 2);
      ctx.lineTo(cx + sx * 12, y + r + 16);
      ctx.lineTo(cx + sx * 8, y + r + 11);
      ctx.lineTo(cx + sx * 2, y + r + 15);
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = CEL.ink;
      ctx.stroke();
    }
  }
  ctx.fillStyle = CEL.shadow;
  ctx.beginPath();
  ctx.arc(cx + 2, y + lip + 3, r + 2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = CEL.ink;
  ctx.beginPath();
  ctx.arc(cx, y + lip, r + 2, 0, TAU);
  ctx.arc(cx, y, r + 2, 0, TAU);
  ctx.rect(cx - r - 2, y, (r + 2) * 2, lip);
  ctx.fill();
  ctx.fillStyle = mixHex(face, '#000000', 0.4);
  ctx.beginPath();
  ctx.arc(cx, y + lip, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(cx, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.beginPath();
  ctx.ellipse(cx - 1, y - r * 0.5, r * 0.62, r * 0.32, 0, 0, TAU);
  ctx.fill();
  if (self.ability) strokeIcon(ctx, PERK_ICONS[self.ability], cx, y, 20, cooling ? 'rgba(236, 230, 214, 0.5)' : CEL.ink, 2.6);
  else if (pick) text(ctx, '!', cx, y + 1, 24, CEL.ink, 'center', 800);
  else strokeIcon(ctx, UI_ICONS.lock, cx, y, 17, PANEL_MUTED, 2.6);
  if (cooling) {
    // The wedge still to wait covers the face, shrinking clockwise as the cooldown runs.
    ctx.fillStyle = 'rgba(14, 16, 21, 0.68)';
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.arc(cx, y, r, -Math.PI / 2 + (1 - left) * TAU, -Math.PI / 2 + TAU);
    ctx.closePath();
    ctx.fill();
    outlined(ctx, (self.abilityReadyIn / 1000).toFixed(self.abilityReadyIn >= 10000 ? 0 : 1), cx, y + 1, TYPE.label, PANEL_INK, 800);
  }
  const pulse = (t - abilityBackAt) / ABILITY_CUE.readyPulseMs;
  if (ready && pulse >= 0 && pulse < 1) {
    if (!REDUCED && vfx.abilitySpark !== abilityBackAt) { vfx.abilitySpark = abilityBackAt; burst(vitalsAt.x + cx, vitalsAt.y + y, 9, PALETTE.gold, 34, t, 4.5); }
    ctx.globalAlpha = 1 - pulse;
    ctx.lineWidth = 3;
    ctx.strokeStyle = PALETTE.gold;
    ctx.beginPath();
    ctx.arc(cx, y, r + 3 + pulse * 14, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // The label under it: the key when ready (a keycap), a dimmer one while cooling, or the unlock note before it is earned.
  if (opts.side) {
    const lx = cx + r + 9;
    if (self.ability) {
      const label = touchScreen ? 'READY' : 'SPACE';
      setFont(ctx, 800, TYPE.micro);
      const kw = ctx.measureText(label).width + 12;
      cel(ctx, lx, y - 8, kw, 15, ready ? '#ece6d6' : '#2f343d', 4, 2);
      text(ctx, label, lx + kw / 2, y, TYPE.micro, ready ? CEL.ink : PANEL_MUTED, 'center', 800);
    } else inked(ctx, pick ? 'PICK' : abilityHint(self.pending)[1], lx, y + 1, TYPE.micro, pick ? PALETTE.gold : PANEL_INK, 800);
    return;
  }
  const ly = y + r + 12;
  if (self.ability) {
    const label = touchScreen ? 'READY' : 'SPACE';
    setFont(ctx, 800, TYPE.micro);
    const kw = ctx.measureText(label).width + 12;
    cel(ctx, cx - kw / 2, ly - 8, kw, 15, ready ? '#ece6d6' : '#2f343d', 4, 2);
    text(ctx, label, cx, ly, TYPE.micro, ready ? CEL.ink : PANEL_MUTED, 'center', 800);
  } else {
    text(ctx, pick ? 'PICK' : abilityHint(self.pending)[1], cx, ly, TYPE.micro, pick ? PALETTE.gold : PANEL_INK, 'center', 800);
  }
}

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
 * an inked count for ammo, an enamel medal token for the ability and round pins for level and perks. The corner kit sits top
 * left; the ammo count rides beside the reticle (a near-the-gun readout is read fastest), or beside your soldier on a touch screen,
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

/** The ability as an enamel medal: ribbon tails, a lit face with its icon, the cooldown wedge, READY glow, and its key stamped beside it. */
function drawMedalToken(ctx: CanvasRenderingContext2D, x: number, y: number, self: SelfView, now: number) {
  drawAbility(ctx, x, y, 17, self, now, { side: true, ribbon: true });
}

/** Level as a pin ringed in XP, the XP count beside it, and the perks as small pins. Returns the width used. */
function drawRankRow(ctx: CanvasRenderingContext2D, x: number, y: number, lp: { displayLevel: number; frac: number }, owned: PerkId[], now: number): number {
  const lvPop = popOf(now - vfx.levelAt, 380);
  if (vfx.levelBurst) { vfx.levelBurst = false; burst(x + 13, y, 16, PALETTE.gold, 80, now, 5.5); }
  drawLevelRing(ctx, x + 13, y, lp.displayLevel, vfx.shownFrac, lvPop);
  const xp = String(Math.round(vfx.shownScore));
  inked(ctx, xp, x + 33, y + 1, TYPE.body, PALETTE.gold, 800);
  setFont(ctx, 800, TYPE.body);
  let px = x + 33 + ctx.measureText(xp).width + 14;
  for (const perk of owned) {
    pin(ctx, px + 11, y - 1, 11, '#4c535f');
    strokeIcon(ctx, PERK_ICONS[perk], px + 11, y - 1, 14, PANEL_INK, 2.4);
    px += 28;
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
  const X0 = EDGE + ins.l, Y0 = EDGE + ins.t;
  vitalsAt.x = X0;
  vitalsAt.y = Y0;
  const lp = levelProgress(me.level, me.score);
  stepVitals(hud, me, self, lp.displayLevel, lp.frac);
  const owned = ([1, 2, 3] as Tier[]).flatMap((t) => (self.perks[t] && t !== ABILITY_TIER ? [self.perks[t]!] : []));
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
  // The health cross, with the armor chip and the health statuses (shield, rush) beside it.
  const S = compact || touchScreen ? HEALTH.compactSize : HEALTH.size;
  const bx = X0, by = touchScreen ? Y0 : h - EDGE - ins.b - S;
  const shield = me.spawnShield ? 'spawn' : me.shield ? 'perk' : null;
  drawHealthCross(ctx, bx, by, S, look, colorHexOf(snap, me.id, me.team), shield, now);
  panels.push({ x: bx - 6, y: by - 6, w: S + 12, h: S + 12 });
  const tier = ARMOR_IDS.indexOf(me.armorTier);
  const healthTabs: [string, string, string][] = [];
  if (shield) healthTabs.push([shield === 'spawn' ? 'SPAWN' : 'SHIELD', STATUS.shield, PERK_ICONS.shield]);
  if (me.rush) healthTabs.push(self.perks[2] === 'secondWind' ? ['WIND', STATUS.rush, PERK_ICONS.secondWind] : ['RUSH', STATUS.rush, PERK_ICONS.adrenaline]);
  // The corner kit: ability medal, then level and perks; beside the cross on a touch screen.
  const kitX = touchScreen ? X0 + S + 16 : X0;
  const rowY = Y0 + 22;
  drawMedalToken(ctx, kitX + 18, rowY, self, now);
  const kitW = drawRankRow(ctx, kitX + 98, rowY, lp, owned, now);
  panels.push({ x: kitX, y: rowY - 20, w: 98 + kitW, h: 52 });
  // Tabs while in effect, in a row under the kit; on a desktop the health ones sit by the cross instead.
  let cx = kitX;
  let sy = rowY + 40;
  // Each tab goes on the row, wrapping before it would reach `limit`: on a phone that is the chat's left edge at the top centre.
  const limit = touchScreen ? w / 2 - Math.min(360, 0.44 * w * hudScale) / 2 / hudScale - 6 : Infinity;
  const put = (width: number, draw: (x: number, y: number) => void) => {
    if (cx > kitX && cx + width > limit) { cx = kitX; sy += 24; }
    draw(cx, sy);
    cx += width + 6;
  };
  const tabWidth = (label: string) => { setFont(ctx, 800, TYPE.micro); return ctx.measureText(label).width + 29; };
  if (touchScreen) {
    if (tier > 0) put(50, (x, y) => drawArmorChip(ctx, x, y, tier));
    for (const [label, color, icon] of healthTabs) put(tabWidth(label), (x, y) => statusTab(ctx, x, y, label, color, icon));
  } else {
    const sx = bx + S + 8;
    let ty = by + S / 2;
    if (drawArmorChip(ctx, sx, ty, tier) > 0) ty -= 26;
    for (const [label, color, icon] of healthTabs) { statusTab(ctx, sx, ty, label, color, icon); ty -= 24; }
  }
  if (self.sprint === true) put(tabWidth('SPRINT'), (x, y) => statusTab(ctx, x, y, 'SPRINT', STATUS.sprint, PERK_ICONS.marathon));
  if (me.hunted) put(huntedBadgeWidth(ctx), (x, y) => drawHuntedBadge(ctx, x, y));
  if (self.streak >= 2) put(streakBadgeWidth(ctx, self.streak), (x, y) => drawStreakBadge(ctx, x, y, self.streak, now));
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
