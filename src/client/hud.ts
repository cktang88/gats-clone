import { stickRadius, stickVector, type Sticks } from './touch.ts';
import { ABILITY_COOLDOWN_MS, COLORS, GUN_IDS, GUNS, LEVELS, PERK_INFO, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, type BuildingKind, type GunId, type PendingPick, type PerkId, type Tier } from '../shared/defs.ts';
import { MAP_MS } from '../shared/maps.ts';
import type { PlayerView, Snapshot } from '../shared/protocol.ts';
import { worldToScreen, type Camera, type Point } from './camera.ts';
import { clearOfRects, clock, edgePoint, boardRows, feedMentions, levelProgress, mapNotice, mostKillsText, objectiveFor, roundTimeLeft, type Rect } from './derive.ts';
import { ASSIST_MS, HITMARKER_MS, HURT_ARC_MS, HURT_MS } from './feedback.ts';
import { serverNow } from './interp.ts';
import { PERK_ICONS, strokeIcon, UI_ICONS } from './icons.ts';
import { CALLOUT_MS, POPUP_MS, RING_MS } from './moments.ts';
import { glow, PALETTE, TEAM_COLORS, tint, ZOMBIE_LOOK } from './palette.ts';
import { nightAmount } from './render.ts';
import { CORE_ALERT_MS } from './siege.ts';
import { BUILD_HINTS, downedLine, forecast, phaseLine, readyHint, squadShare, useHint } from './zombies.ts';
import { drawGunGlyph } from './sprites.ts';
import type { Session } from './state.ts';

const HUD_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const TYPE = { micro: 10, label: 11, body: 13, title: 15, figure: 17 } as const;
const SPACE = { sm: 8, md: 12, lg: 16 } as const;
const PANEL_FILL = 'rgba(96, 101, 112, 0.94)';
const PANEL_INK = '#f1f2f5';
const PANEL_MUTED = '#c4c8d0';
const PANEL_RADIUS = 6;
const ON_WORLD = {
  day: { ink: '#454953', muted: '#80848e', track: '#9b9fa9', glyph: '#4f535d', halo: 'rgba(230, 229, 232, 0.9)' },
  night: { ink: '#eef1f6', muted: '#b4bccb', track: 'rgba(210, 216, 230, 0.35)', glyph: '#dfe4ee', halo: 'rgba(24, 30, 56, 0.6)' },
} as const;
type OnWorld = (typeof ON_WORLD)[keyof typeof ON_WORLD];
const EDGE = 16;
/** Notch and home-indicator insets in HUD units; every corner panel sits inside them. */
let inset = { l: 0, t: 0, r: 0, b: 0 };
export const setHudInsets = (i: { l: number; t: number; r: number; b: number }): void => { inset = i; };
const FEED_ROW = 24;
const FEED_MS = 6000;
const TAU = Math.PI * 2;
const HURT_BANDS = 12;
const HURT_EDGE = { depth: 0.06, alpha: 0.05, alphaPerStrength: 0.12 } as const;
const HP_FILL = ['#ef6b60', '#d6463e'] as const;

type Hud = { ctx: CanvasRenderingContext2D; w: number; h: number; snap: Snapshot; s: Session; me: PlayerView | null; now: number; dt: number; cam: Camera; selfAt: Point; on: OnWorld };

const GUN_BY_NAME = new Map<string, GunId>(GUN_IDS.map((id) => [GUNS[id].name, id]));
const PERK_BY_NAME = new Map<string, PerkId>(Object.entries(PERK_INFO).map(([id, info]) => [info.name, id as PerkId]));

export function drawSticks(ctx: CanvasRenderingContext2D, sticks: Sticks) {
  for (const st of [sticks.move, sticks.aim]) {
    if (!st) continue;
    const v = stickVector(st);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(st.ox, st.oy, stickRadius(), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(st.ox + v.x * stickRadius(), st.oy + v.y * stickRadius(), stickRadius() * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** `spread` is your current aim spread, or null when no reticle should be drawn. */
export function drawHud(ctx: CanvasRenderingContext2D, dpr: number, cam: Camera, snap: Snapshot, s: Session, now: number, crosshair: Point, spread: number | null, fullBoard = false) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hudFont = '';
  const { w, h } = cam;
  const me = snap.players.find((p) => p.id === s.myId) ?? null;
  const on = nightAmount() > 0.5 ? ON_WORLD.night : ON_WORLD.day;
  const hud: Hud = { ctx, w, h, snap, s, me, now, dt: Math.min(100, Math.max(0, now - lastHudAt)), cam, selfAt: worldToScreen(cam, s.lastSelf), on };
  lastHudAt = now;
  panels = [];
  buildChips = [];
  const compact = w < 640 || h < 520;
  drawHurtVignette(hud);
  drawHurtArcs(hud);
  const boardBottom = drawLeaderboard(hud, compact, fullBoard);
  const mapSize = compact ? 96 : 160;
  // On a short screen the feed must stop above the minimap instead of running underneath it.
  const feedRoom = h - EDGE - inset.b - mapSize - 16 - SPACE.sm - (boardBottom + SPACE.sm);
  drawKillFeed(hud, boardBottom + SPACE.sm, Math.max(0, Math.min(compact ? 3 : 5, Math.floor(feedRoom / FEED_ROW))));
  drawMinimap(hud, mapSize);
  const below = drawPill(hud, compact);
  ctx.globalAlpha = 1;
  const siegeTop = drawObjectiveLine(hud, below, fullBoard);
  if (me?.alive) drawVitals(hud, compact);
  if (snap.run) drawSiege(hud, snap.run, siegeTop, compact);
  drawHuntedArrows(hud);
  drawScorePopups(hud);
  drawCallouts(hud);
  if (spread !== null) drawReticle(hud, crosshair, spread);
  drawHitmarker(hud, crosshair);
  drawAssist(hud, crosshair);
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
  ctx.moveTo(11, 0);
  ctx.lineTo(-6, -9);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-6, 9);
  ctx.closePath();
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
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = PALETTE.hunted;
  for (const arc of s.feedback.arcs) {
    const k = (now - arc.born) / HURT_ARC_MS;
    if (k < 0 || k >= 1) continue;
    ctx.globalAlpha = (1 - k * k) * (0.45 + 0.45 * arc.strength);
    ctx.beginPath();
    ctx.arc(selfAt.x, selfAt.y, ARC.radius + 6 * k, arc.angle - ARC.half, arc.angle + ARC.half);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawAssist({ ctx, s, now }: Hud, at: Point) {
  const assist = s.feedback.assist;
  if (!assist) return;
  const k = (now - assist.born) / ASSIST_MS;
  if (k < 0 || k >= 1) return;
  ctx.globalAlpha = 1 - k * k;
  outlined(ctx, `+${WORLD.assistScore} assist`, at.x, at.y - 30 - 16 * k, 14, PALETTE.gold, 800);
  ctx.globalAlpha = 1;
}

function drawScorePopups({ ctx, s, now, cam }: Hud) {
  for (const p of s.moments.popups) {
    const k = (now - p.born) / POPUP_MS;
    if (k < 0 || k >= 1) continue;
    const at = worldToScreen(cam, p);
    ctx.globalAlpha = 1 - k * k * k;
    outlined(ctx, `+${p.amount}`, at.x, at.y - 36 - 44 * k, Math.round(17 + 5 * Math.max(0, 1 - k * 5)), PALETTE.gold, 850);
  }
  ctx.globalAlpha = 1;
}

const CALLOUT_GAP = 44;

function drawCallouts({ ctx, w, h, s, now, selfAt }: Hud) {
  let row = 0;
  for (const c of s.moments.callouts) {
    const age = now - c.born;
    if (age < 0 || age >= CALLOUT_MS) continue;
    if (c.ring && age < RING_MS) drawRingBurst(ctx, selfAt, c.color, age);
    const pop = 1 + 0.25 * Math.max(0, 1 - age / 160);
    ctx.globalAlpha = Math.min(1, age / 90, (CALLOUT_MS - age) / 450);
    const y = h * 0.24 + row * CALLOUT_GAP;
    outlined(ctx, c.title, w / 2, y, Math.round(22 * pop), c.color, 850);
    outlined(ctx, c.line, w / 2, y + 20, TYPE.body, '#ffffff', 600);
    row++;
  }
  ctx.globalAlpha = 1;
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

const RETICLE = { minGap: 5, maxGap: 90, tick: 7, ring: 6, ringClearance: 6 } as const;

export const reticleGap = (spread: number, distPx: number): number =>
  Math.min(RETICLE.maxGap, Math.max(RETICLE.minGap, Math.tan(spread) * distPx));

let reticleDrawnGap = 0;
export const drawnReticleGap = (): number => reticleDrawnGap;

function drawReticle({ ctx, snap, selfAt }: Hud, at: Point, spread: number) {
  const reloading = snap.self.reloading;
  const gap = Math.max(reloading ? RETICLE.ring + RETICLE.ringClearance : 0, reticleGap(spread, Math.hypot(at.x - selfAt.x, at.y - selfAt.y)));
  reticleDrawnGap = gap;
  ctx.lineCap = 'round';
  for (const [width, color] of [[3.5, 'rgba(30, 32, 38, 0.5)'], [1.5, '#ffffff']] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(at.x + dx * gap, at.y + dy * gap);
      ctx.lineTo(at.x + dx * (gap + RETICLE.tick), at.y + dy * (gap + RETICLE.tick));
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(at.x - 1, at.y - 1, 2, 2);
  if (!reloading) return;
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(30, 32, 38, 0.5)';
  ctx.beginPath();
  ctx.arc(at.x, at.y, RETICLE.ring, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.arc(at.x, at.y, RETICLE.ring, -Math.PI / 2, -Math.PI / 2 + snap.self.reloadFrac * TAU);
  ctx.stroke();
}

function drawHitmarker({ ctx, s, now }: Hud, at: Point) {
  const hm = s.feedback.hitmarker;
  if (!hm) return;
  const k = (now - hm.born) / HITMARKER_MS[hm.kill ? 'kill' : 'hit'];
  if (k < 0 || k >= 1) return;
  const [inner, outer] = hm.kill ? [7, 15] : [5, 10];
  const pop = 1 + (1 - k) * 0.25;
  ctx.globalAlpha = 1 - k * k;
  ctx.lineCap = 'round';
  for (const [width, color] of [[4, 'rgba(30, 32, 38, 0.5)'], [hm.kill ? 2.5 : 2, hm.kill ? '#ff4d4f' : '#ffffff']] as const) {
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

const MINIMAP = { bg: 'rgba(92, 98, 108, 0.94)', block: '#959aa4', built: '#7f8fb0' } as const;
const MINIMAP_BUILDING: Record<BuildingKind, string> = { wall: '#c7a383', sentry: '#f5c400', cannon: '#ff6b3d', scatter: '#3fd1b8', mortar: '#b98cff' };

/** Panels drawn this frame, so edge markers drawn after them can stay clear. */
let panels: Rect[] = [];

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number | number[] = PANEL_RADIUS, fill: string = PANEL_FILL) {
  panels.push({ x, y, w, h });
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
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
function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number) {
  const key = weight * 1000 + size;
  let font = fonts.get(key);
  if (!font) fonts.set(key, (font = `${weight} ${size}px ${HUD_FONT}`));
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

function outlined(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight: number) {
  setFont(ctx, weight, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.5, size / 6);
  ctx.strokeStyle = 'rgba(28, 30, 36, 0.7)';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

const FEED_ICON_W = 34;
const BOUNTY_TAG = `+${WORLD.bountyScore} BOUNTY`;

/** Class guns read as their icon; an evolved gun is spelled out in its accent color, since its silhouette is easy to mistake. */
function feedWeapon(ctx: CanvasRenderingContext2D, label: string): { width: number; draw(x: number, y: number): void } {
  const gun = GUN_BY_NAME.get(label);
  if (gun && GUNS[gun].stage === 0) {
    return { width: FEED_ICON_W, draw: (x, y) => drawGunGlyph(ctx, gun, x, y, FEED_ICON_W - SPACE.sm, 10, PANEL_INK) };
  }
  const perk = PERK_BY_NAME.get(label);
  if (perk) return { width: 20, draw: (x, y) => strokeIcon(ctx, PERK_ICONS[perk], x + 8, y, 13, PANEL_INK, 2.2) };
  const [color, weight] = gun ? [glow(GUNS[gun].look.accent, 0.74), 800] : [PANEL_MUTED, 500];
  setFont(ctx, weight, TYPE.label);
  return { width: ctx.measureText(label).width + SPACE.sm, draw: (x, y) => text(ctx, label, x, y, TYPE.label, color, 'left', weight) };
}

const LIFE_LINE = { downed: PALETTE.hunted, revived: PALETTE.hpGood, bledOut: PANEL_MUTED } as const;

function drawKillFeed(hud: Hud, top: number, rows: number) {
  const { ctx, w, s, now } = hud;
  if (rows <= 0) return;
  const lines = s.feed.filter((f) => now - f.at < FEED_MS).slice(-rows);
  const right = w - EDGE - inset.r;
  lines.forEach((f, i) => {
    const y = top + i * FEED_ROW + 10;
    ctx.globalAlpha = Math.min(1, (FEED_MS - (now - f.at)) / 600) * 0.95;
    setFont(ctx, 650, TYPE.label + 1);
    if (f.e === 'life') {
      const by = f.by === null ? null : hud.snap.players.find((p) => p.id === f.by)?.name ?? hud.snap.leaderboard.find((r) => r.id === f.by)?.name;
      const [line, color] = f.k === 'downed' ? [`${f.name} is down`, LIFE_LINE.downed] : f.k === 'revived' ? [by ? `${by} revived ${f.name}` : `${f.name} is back up`, LIFE_LINE.revived] : [`${f.name} bled out`, LIFE_LINE.bledOut];
      const pw = ctx.measureText(line).width + SPACE.md * 2;
      feedRow(ctx, right - pw, y, pw, f.id === s.myId);
      ctx.fillStyle = color;
      ctx.fillRect(right - pw + 4, y - 5, 2, 10);
      text(ctx, line, right - pw + SPACE.md, y, TYPE.label + 1, PANEL_INK, 'left', 650);
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
    const weapon = feedWeapon(ctx, f.weapon);
    setFont(ctx, 800, TYPE.micro);
    const bw = f.bounty ? ctx.measureText(BOUNTY_TAG).width + SPACE.sm : 0;
    const pw = kw + vw + weapon.width + bw + SPACE.md * 2 + (f.killer ? SPACE.sm : 0);
    let x = right - pw;
    feedRow(ctx, x, y, pw, feedMentions(f, s.myId));
    x += SPACE.md;
    if (f.killer) { text(ctx, f.killer, x, y, TYPE.label + 1, nameColor(hud, f.killerId), 'left', 650); x += kw + SPACE.sm; }
    weapon.draw(x, y);
    x += weapon.width;
    text(ctx, f.victim, x, y, TYPE.label + 1, nameColor(hud, f.victimId), 'left', 650);
    if (f.bounty) text(ctx, BOUNTY_TAG, x + vw + SPACE.sm, y, TYPE.micro, FEED_TEAM.red, 'left', 800);
    ctx.globalAlpha = 1;
  });
}

function feedRow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, mine: boolean) {
  panel(ctx, x, y - 10, w, 20, 5);
  if (!mine) return;
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x + 0.75, y - 9.25, w - 1.5, 18.5, 5);
  ctx.stroke();
}

const FEED_TEAM = { red: '#ffb0b2', blue: '#b5c6ff' } as const;

function nameColor({ s, snap, me }: Hud, id: number | null): string {
  if (id === s.myId) return me ? ownColor(snap, me) : PALETTE.gold;
  const team = id === null ? null : snap.leaderboard.find((r) => r.id === id)?.team ?? null;
  return team && !snap.run ? FEED_TEAM[team] : PANEL_INK;
}

const ownColor = (snap: Snapshot, me: PlayerView) => (me.team && !snap.run ? FEED_TEAM[me.team] : tint(COLORS[me.color], 0.55));

const timeLeft = ({ snap, s, now }: Hud) => roundTimeLeft(snap.match, serverNow(s.snaps, now));

const BOARD = { w: 168, compactW: 140, row: 21, pad: 10 } as const;

function drawLeaderboard(hud: Hud, compact: boolean, full: boolean): number {
  const { ctx, w, h, snap, s, me } = hud;
  const rows = boardRows(snap.leaderboard, s.myId, full ? (compact || h < 760 ? 6 : 12) : null);
  const teams = snap.match.mode === 'TDM' || snap.match.mode === 'DOM';
  const pw = compact ? BOARD.compactW : BOARD.w;
  const x = w - pw - EDGE - inset.r, top = EDGE + inset.t;
  const split = rows.length > 1 && rows.at(-1)!.place - rows.at(-2)!.place > 1;
  const head = full ? 22 : 0;
  const ph = BOARD.pad * 2 + rows.length * BOARD.row + head + (split ? 5 : 0);
  fadePanel(hud, 'board', x, top, pw, ph);
  panel(ctx, x, top, pw, ph);
  let y = top + BOARD.pad + BOARD.row / 2;
  if (full) {
    const line = snap.run ? 'Squad kills' : teams ? `First to ${snap.match.mode === 'TDM' ? WORLD.tdmWinScore : WORLD.domWinScore}` : mostKillsText(timeLeft(hud));
    text(ctx, line[0]!.toUpperCase() + line.slice(1), x + BOARD.pad + 2, y - 2, TYPE.micro, PANEL_MUTED, 'left', 600);
    y += head;
  }
  const mineColor = me ? ownColor(snap, me) : PALETTE.gold;
  rows.forEach(({ place, row: r }, i) => {
    if (split && i === rows.length - 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(x + BOARD.pad, y - BOARD.row / 2, pw - BOARD.pad * 2, 1);
      y += 5;
    }
    const mine = r.id === s.myId;
    const color = mine ? mineColor : PANEL_INK;
    const weight = mine ? 750 : 500;
    text(ctx, String(place), x + BOARD.pad + 2, y, TYPE.body, mine ? mineColor : PANEL_MUTED, 'left', weight);
    const nx = x + BOARD.pad + 22;
    if (r.team && teams) {
      ctx.fillStyle = TEAM_COLORS[r.team];
      ctx.beginPath();
      ctx.arc(nx + 3, y, 3, 0, TAU);
      ctx.fill();
    }
    text(ctx, mine ? 'you' : r.name, nx + (r.team && teams ? 11 : 0), y, TYPE.body, color, 'left', weight);
    text(ctx, String(r.kills), x + pw - BOARD.pad - 2, y, TYPE.body, color, 'right', weight);
    y += BOARD.row;
  });
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
  const { ctx, w, h, snap, s, me } = hud;
  const k = size / s.worldSize;
  const pad = 8;
  const x0 = w - EDGE - inset.r - size - pad * 2, y0 = h - EDGE - inset.b - size - pad * 2;
  const base = fadePanel(hud, 'minimap', x0, y0, size + pad * 2, size + pad * 2);
  panel(ctx, x0, y0, size + pad * 2, size + pad * 2, PANEL_RADIUS, MINIMAP.bg);
  const x = x0 + pad, y = y0 + pad;
  for (const wall of s.walls) {
    ctx.fillStyle = wall.built ? MINIMAP.built : MINIMAP.block;
    ctx.fillRect(x + wall.x * k, y + wall.y * k, Math.max(1.5, wall.w * k), Math.max(1.5, wall.h * k));
  }
  for (const z of snap.zones) {
    ctx.beginPath();
    ctx.arc(x + z.x * k, y + z.y * k, Math.max(4, z.r * k), 0, TAU);
    ctx.fillStyle = z.owner ? TEAM_COLORS[z.owner] : PALETTE.neutral;
    ctx.globalAlpha = base * 0.45;
    ctx.fill();
    ctx.globalAlpha = base;
  }
  for (const m of snap.minimap) {
    if (m.pingAge !== null) continue;
    ctx.fillStyle = m.team ? TEAM_COLORS[m.team] : '#ff6b5f';
    ctx.beginPath();
    ctx.arc(x + m.x * k, y + m.y * k, 2.5, 0, TAU);
    ctx.fill();
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
  const self = me ?? s.lastSelf;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + self.x * k, y + self.y * k, 3.5, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPill(hud: Hud, compact: boolean): number {
  const { ctx, w, snap, me, s, now } = hud;
  const ph = compact ? 24 : 28, y = EDGE + inset.t;
  const side = compact ? 40 : 48, mid = compact ? 56 : 66;
  const big = compact ? 14 : 16;
  const left = timeLeft(hud);
  const cy = y + ph / 2;
  if (snap.match.mode === 'TDM' || snap.match.mode === 'DOM') {
    const x = w / 2 - side - mid / 2;
    fadePanel(hud, 'score', x, y, side * 2 + mid, ph);
    panel(ctx, x, y, side * 2 + mid, ph);
    for (const [team, bx] of [['red', x], ['blue', x + side + mid]] as const) {
      text(ctx, String(snap.match.teamScore[team]), bx + side / 2, cy + 1, big, FEED_TEAM[team], 'center', 800);
      if (me?.team === team) {
        ctx.fillStyle = FEED_TEAM[team];
        ctx.fillRect(bx + side / 2 - 7, y + ph - 4, 14, 2);
      }
    }
    const center = snap.match.mode === 'DOM' ? `to ${WORLD.domWinScore}` : left === null ? `to ${WORLD.tdmWinScore}` : clock(left);
    text(ctx, center, x + side + mid / 2, cy + 1, TYPE.body, PANEL_INK, 'center', 600);
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
  const x = w / 2 - mid / 2;
  fadePanel(hud, 'score', x, y, mid, ph);
  panel(ctx, x, y, mid, ph);
  text(ctx, left === null ? clock(MAP_MS.FFA) : clock(left), x + mid / 2, cy + 1, TYPE.body + 1, PANEL_INK, 'center', 650);
  return y + ph;
}

function drawObjectiveLine(hud: Hud, top: number, full: boolean): number {
  const { ctx, w, snap, me } = hud;
  if (!me) return top;
  const lines: [string, string][] = [];
  if (full) lines.push([snap.run ? `${snap.match.map} · ${phaseLine(snap.run, serverNow(hud.s.snaps, hud.now))}` : `${snap.match.map} · ${objectiveFor(snap.match.mode, me.team, timeLeft(hud)).line}`, PANEL_INK]);
  const notice = mapNotice(snap.match);
  if (notice) lines.push([notice, PALETTE.gold]);
  let y = top + 6;
  for (const [line, color] of lines) {
    setFont(ctx, 600, TYPE.label);
    const lw = ctx.measureText(line).width + 18;
    panel(ctx, w / 2 - lw / 2, y, lw, 20, 5);
    text(ctx, line, w / 2, y + 10, TYPE.label, color, 'center', 600);
    y += 24;
  }
  return y - 4;
}

function drawSiege(hud: Hud, run: NonNullable<Snapshot['run']>, top: number, compact: boolean) {
  const { ctx, w, h, s, me, now, on } = hud;
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
  setFont(ctx, 700, TYPE.label);
  const mournedW = mourned ? ctx.measureText(mourned).width + 8 : 0;
  const total = 16 + scrapW + 44 + 16 + 90 + 14 + peopleW + 58 + mournedW;
  let x = cx - total / 2;
  panel(ctx, x - 10, y - 11, total + 20, 22, 5);
  strokeIcon(ctx, UI_ICONS.scrap, x + 6, y, 12, PALETTE.gold, 2.2);
  text(ctx, `${run.scrap}`, x + 16, y, TYPE.body, PANEL_INK, 'left', 750);
  x += 16 + scrapW + 6;
  text(ctx, 'scrap', x, y, TYPE.label, PANEL_MUTED, 'left', 500);
  x += 38;
  strokeIcon(ctx, UI_ICONS.core, x + 6, y, 12, coreColor, 2.2);
  bar(ctx, x + 16, y - 3, 90, 6, frac, coreColor, 'rgba(255, 255, 255, 0.18)');
  x += 16 + 90 + 14;
  text(ctx, people, x, y, TYPE.body, alert ? coreColor : PANEL_INK, 'left', 750);
  text(ctx, 'survivors', x + peopleW + 6, y, TYPE.label, PANEL_MUTED, 'left', 500);
  if (mourned) text(ctx, mourned, x + peopleW + 66, y, TYPE.label, PALETTE.lossOnDark, 'left', 700);
  if (alert) drawCoreAlert(hud, run.core, y + 26);
  if (run.phase === 'over') return;
  if (run.phase === 'day') outlined(ctx, `Tonight · ${forecast(run.night, squadShare(hud.snap.players))}`, cx, y + 26, TYPE.label + 1, PALETTE.gold, 700);
  if (me?.downed) {
    const k = 0.5 + 0.5 * Math.sin(now / 260);
    outlined(ctx, "You're down", w / 2, h * 0.64, 22, PALETTE.hunted, 850);
    outlined(ctx, downedLine(me.downed, serverNow(s.snaps, now)), w / 2, h * 0.64 + 24, TYPE.body + 1, '#ffffff', 650);
    ctx.globalAlpha = 0.6 + 0.4 * k;
    bar(ctx, w / 2 - 90, h * 0.64 + 40, 180, 5, me.downed.revive, PALETTE.hpGood, on.track);
    ctx.globalAlpha = 1;
    return;
  }
  if (!me?.alive) return;
  const use = useHint(hud.snap, s.lastSelf);
  const row = h - inset.b - (compact && w < h ? 150 : 30);
  if (use) outlined(ctx, use, w / 2, h * 0.64, TYPE.body + 1, PALETTE.gold, 750);
  if (s.building) {
    hintBar(ctx, s, BUILD_HINTS.filter((p) => p.pick), w / 2, row - 32, null);
    hintBar(ctx, s, BUILD_HINTS.filter((p) => !p.pick), w / 2, row, 'BUILD');
  } else if (run.phase === 'day') {
    hintBar(ctx, s, [{ key: 'B', what: 'build walls and turrets' }, { key: 'N', what: readyHint(run, hud.snap.players, hud.snap.self.id) }], w / 2, row, null);
  }
}

function hintBar(ctx: CanvasRenderingContext2D, s: Session, hints: readonly { key: string; what: string; pick?: BuildingKind }[], cx: number, row: number, label: string | null) {
  setFont(ctx, 650, TYPE.label);
  const parts = hints.map((p) => ({ ...p, kw: ctx.measureText(p.key).width + 10, ww: ctx.measureText(p.what).width }));
  const total = parts.reduce((t, p) => t + p.kw + p.ww + 22, label ? 56 : 0) + 8;
  let hx = cx - total / 2;
  panel(ctx, hx, row - 12, total, 24);
  hx += 10;
  if (label) {
    text(ctx, label, hx, row, TYPE.label, PALETTE.gold, 'left', 850);
    hx += 48;
  }
  for (const p of parts) {
    const picked = p.pick !== undefined && p.pick === s.buildKind;
    ctx.fillStyle = picked ? PALETTE.gold : 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.roundRect(hx, row - 8, p.kw, 16, 3);
    ctx.fill();
    text(ctx, p.key, hx + 5, row, TYPE.label, picked ? '#16181d' : PANEL_INK, 'left', 750);
    text(ctx, p.what, hx + p.kw + 5, row, TYPE.label, picked ? PALETTE.gold : PANEL_MUTED, 'left', picked ? 750 : 550);
    if (p.pick) buildChips.push({ kind: p.pick, x: hx - 4, y: row - 12, w: p.kw + p.ww + 12, h: 24 });
    hx += p.kw + p.ww + 22;
  }
}

/** The build bar's kind chips as last drawn, in CSS px, so a click on one picks its kind. */
let buildChips: (Rect & { kind: BuildingKind })[] = [];
export const drawnBuildChips = (): readonly (Rect & { kind: BuildingKind })[] => buildChips;
export const buildChipAt = (x: number, y: number): BuildingKind | null =>
  buildChips.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)?.kind ?? null;

function drawCoreAlert({ ctx, w, h, now, cam, selfAt }: Hud, core: { x: number; y: number }, y: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 110);
  ctx.globalAlpha = 0.7 + 0.3 * pulse;
  outlined(ctx, 'CORE UNDER ATTACK', w / 2, y, 15, PALETTE.hunted, 850);
  ctx.globalAlpha = 1;
  const at = edgePoint(selfAt, worldToScreen(cam, core), w, h, EDGE_INSET + 10);
  if (!at) return;
  const clear = clearOfRects(selfAt, at, panels, ARROW_CLEARANCE);
  edgeArrow(ctx, clear, at.angle, 1.25 + 0.2 * pulse, 1);
  strokeIcon(ctx, UI_ICONS.core, clear.x - Math.cos(at.angle) * 24, clear.y - Math.sin(at.angle) * 24, 15, PALETTE.hunted, 2.4);
}

const VITALS = { bar: 200, compactBar: 110, barH: 9, row: 30 } as const;

function drawAmmoGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const bx = x + i * 6;
    ctx.moveTo(bx, y + 7);
    ctx.lineTo(bx, y - 4);
    ctx.lineTo(bx + 2, y - 8);
    ctx.lineTo(bx + 4, y - 4);
    ctx.lineTo(bx + 4, y + 7);
    ctx.closePath();
  }
  ctx.fill();
}

function drawVitals({ ctx, snap, me, w, on }: Hud, compact: boolean) {
  if (!me) return;
  const self = snap.self;
  const x = EDGE + 4 + inset.l;
  let y = EDGE + 10 + inset.t;
  const bw = compact ? VITALS.compactBar : Math.min(VITALS.bar, w * 0.22);
  panels.push({ x: EDGE + inset.l, y: EDGE + inset.t, w: bw + 150, h: 4 * VITALS.row });
  const hpFrac = me.hp / me.maxHp;
  const fill = ctx.createLinearGradient(x, 0, x + bw, 0);
  fill.addColorStop(0, HP_FILL[0]);
  fill.addColorStop(1, HP_FILL[1]);
  bar(ctx, x, y - VITALS.barH / 2, bw, VITALS.barH, hpFrac, fill, on.track);
  const hpText = `${Math.ceil(me.hp)} / ${me.maxHp}`;
  worldText(ctx, on, hpText, x + bw + 10, y, TYPE.body + 1, hpFrac <= 0.35 ? PALETTE.hpBad : on.muted, 500);
  if (me.hunted) {
    setFont(ctx, 500, TYPE.body + 1);
    drawHuntedBadge(ctx, x + bw + 20 + ctx.measureText(hpText).width, y);
  }
  y += VITALS.row;
  drawAmmoGlyph(ctx, x, y, on.glyph);
  if (self.reloading) {
    worldText(ctx, on, 'reloading', x + 34, y, TYPE.body, PALETTE.gold, 700);
    bar(ctx, x + 104, y - 2, 60, 4, self.reloadFrac, PALETTE.gold, on.track);
  } else {
    worldText(ctx, on, `${self.ammo} / ${self.mag}`, x + 34, y + 1, TYPE.figure, self.ammo === 0 ? PALETTE.hpBad : on.ink, 750);
  }
  y += 24;
  const lp = levelProgress(me.level, me.score);
  const gun = GUNS[me.gun];
  setFont(ctx, 700, TYPE.micro);
  const gunName = gun.name.toUpperCase();
  worldText(ctx, on, gunName, x, y, TYPE.micro, gun.stage ? gun.look.accent : on.muted, 700);
  let lx = x + ctx.measureText(gunName).width + 6;
  if (gun.stage) { drawStagePips(ctx, me.gun, lx, y); lx += gun.stage * 9 + 4; }
  worldText(ctx, on, `LV ${lp.displayLevel}`, lx + 4, y, TYPE.micro, on.muted, 700);
  bar(ctx, lx + 36, y - 1.5, 44, 3, lp.frac, PALETTE.gold, on.track);
  y += 22;
  drawAbility(ctx, x, y, self, on);
  const owned = ([1, 2, 3] as Tier[]).flatMap((t) => (self.perks[t] && t !== ABILITY_TIER ? [self.perks[t]!] : []));
  let px = x + abilityWidth(ctx, self) + 14;
  for (const perk of owned) {
    strokeIcon(ctx, PERK_ICONS[perk], px + 7, y, 13, on.glyph, 2.2);
    px += 22;
  }
}

type SelfView = Snapshot['self'];

const abilityLabel = (self: SelfView): string =>
  self.ability ? (self.abilityReadyIn > 0 ? `${(self.abilityReadyIn / 1000).toFixed(1)}s` : 'SPACE') : abilityHint(self.pending).join(' ');

function abilityWidth(ctx: CanvasRenderingContext2D, self: SelfView): number {
  setFont(ctx, 700, TYPE.micro);
  return 22 + ctx.measureText(abilityLabel(self)).width;
}

function drawAbility(ctx: CanvasRenderingContext2D, x: number, y: number, self: SelfView, on: OnWorld) {
  if (!self.ability) {
    worldText(ctx, on, abilityLabel(self), x, y, TYPE.micro, on.muted, 600);
    return;
  }
  const ready = self.abilityReadyIn <= 0;
  const left = Math.max(0, Math.min(1, self.abilityReadyIn / ABILITY_COOLDOWN_MS[self.ability]));
  ctx.lineWidth = 2;
  ctx.strokeStyle = on.track;
  ctx.beginPath();
  ctx.arc(x + 8, y, 10, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.arc(x + 8, y, 10, -Math.PI / 2, -Math.PI / 2 + (1 - left) * TAU);
  ctx.stroke();
  strokeIcon(ctx, PERK_ICONS[self.ability], x + 8, y, 11, ready ? PALETTE.gold : on.muted, 2.2);
  worldText(ctx, on, abilityLabel(self), x + 22, y, TYPE.micro, ready ? PALETTE.gold : on.ink, 700);
}

function drawHuntedBadge(ctx: CanvasRenderingContext2D, x: number, y: number) {
  setFont(ctx, 800, TYPE.micro);
  const bw = ctx.measureText('HUNTED').width + 24;
  ctx.beginPath();
  ctx.roundRect(x, y - 9, bw, 18, 4);
  ctx.fillStyle = PALETTE.hunted;
  ctx.fill();
  strokeIcon(ctx, UI_ICONS.target, x + 9, y, 10, '#ffffff', 2.2);
  text(ctx, 'HUNTED', x + 17, y + 0.5, TYPE.micro, '#ffffff', 'left', 800);
}

function drawStagePips(ctx: CanvasRenderingContext2D, gun: GunId, x: number, y: number) {
  const { stage, look } = GUNS[gun];
  ctx.fillStyle = look.accent;
  for (let i = 0; i < stage; i++) {
    const cx = x + 3.5 + i * 9;
    ctx.beginPath();
    ctx.moveTo(cx, y - 3.5);
    ctx.lineTo(cx + 3.5, y);
    ctx.lineTo(cx, y + 3.5);
    ctx.lineTo(cx - 3.5, y);
    ctx.closePath();
    ctx.fill();
  }
}

const ABILITY_TIER: Tier = 3;
const ABILITY_SCORE = LEVELS.find((l) => l.pick?.k === 'perk' && l.pick.tier === ABILITY_TIER)?.score;

export const abilityHint = (pending: PendingPick | null): [string, string] =>
  pending?.k === 'perk' && pending.tier === ABILITY_TIER ? ['Pick an', 'ability'] : ['Ability', `at ${ABILITY_SCORE}`];
