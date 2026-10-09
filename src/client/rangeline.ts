import { GUNS, PERK_INFO, rulesOf, type GunId, type PerkId, type Tier } from '../shared/defs.ts';
import { TARGETS, targetAim, targetBody, targetPos, type RangeLayout, type TargetKind } from '../shared/range.ts';
import { segmentEntersCapsuleAt } from '../shared/sim/movement.ts';
import { MUZZLE_PX } from '../shared/sim/ballistics.ts';
import { rangeFor } from '../shared/sim/stats.ts';
import { INK } from './palette.ts';
import { reducedMotion } from './screenfx.ts';

/**
 * The shooting range's reach marking: where the gun you hold stops reaching, painted on the floor as a dotted signal-orange arc
 * round you, a faint band where its damage falls off, a plate naming the gun and its range, and a pip under every target saying
 * whether a round from where you stand reaches it at full damage, reaches it weakened, or dies short.
 *
 * Reach is a circle, not a line: a round leaves the muzzle `MUZZLE_PX` ahead of your centre and flies `rangeFor(gun, perks)` px in
 * whatever direction you aim (sim.ts, `left: stats.range`). So the arc is centred on you and follows you, and a target in the next
 * lane over is judged by its true distance, not its x. Falloff counts from the muzzle as well (`falloffMul` in sim/stats.ts takes
 * the distance flown). A target is reached when the round aimed at its board meets its body (`targetBody`), as `targetHits` judges a round.
 * Only a Range snapshot (`snap.targets`) ever calls this, so the other modes pay nothing for it.
 */
const ORANGE = '#ff5a1f', BONE = '#ece6d6', MUSTARD = '#b79a4a', GUNMETAL = '#3d4450', MUTED = '#9a9ea6';
const FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';

export type Reach = {
  gun: GunId;
  /** The gun's range after perks: how far a round flies from the muzzle. */
  range: number;
  /** How far from your centre a round can reach: the muzzle offset plus `range`. */
  reach: number;
  /** Where the damage starts falling and where it bottoms out, from your centre (`at`) and from the muzzle (`px`), clamped to the reach. */
  falloff: { start: number; end: number; startPx: number; endPx: number; minMul: number } | null;
  /** The plate's lines: "MAX RANGE 1200 · BOLT-ACTION", then the falloff, if the gun has one. */
  title: string;
  sub: string | null;
};

const reaches = new Map<string, Reach>();
/** The reach of `gun` with `perks` on, as the simulation flies its rounds (kept per loadout, as the frame asks every time). */
export function reachOf(gun: GunId, perks: Partial<Record<Tier, PerkId>>): Reach {
  const key = `${gun}|${perks[1] ?? ''}|${perks[2] ?? ''}|${perks[3] ?? ''}`;
  let r = reaches.get(key);
  if (!r) reaches.set(key, (r = measure(gun, perks)));
  return r;
}

function measure(gun: GunId, perks: Partial<Record<Tier, PerkId>>): Reach {
  const range = rangeFor(gun, perks);
  const reach = MUZZLE_PX + range;
  const f = rulesOf(GUNS[gun]).falloff;
  const falloff = f && f.startPx < range ? { startPx: f.startPx, endPx: Math.min(f.endPx, range), minMul: f.minMul, start: MUZZLE_PX + f.startPx, end: MUZZLE_PX + Math.min(f.endPx, range) } : null;
  const stretch = (Object.values(perks) as PerkId[]).find((p) => rangeFor(gun, { 1: p }) !== GUNS[gun].range);
  const title = `MAX RANGE ${Math.round(range)} · ${GUNS[gun].name.toUpperCase()}${stretch ? ` · ${PERK_INFO[stretch].name.toUpperCase()}` : ''}`;
  const sub = falloff ? `FALLOFF ${falloff.startPx}–${Math.round(falloff.endPx)} → ${Math.round(falloff.minMul * 100)}% DMG` : null;
  return { gun, range, reach, falloff, title, sub };
}

/** The world x of the arc's far point, level with you: where a round fired straight down the lanes from `x` dies. */
export const rangeLineX = (r: Reach, x: number): number => x + r.reach;

export type ReachClass = 'full' | 'falloff' | 'out';

/**
 * Whether a round aimed from `from` at a `kind` target standing at `at` (at its board, `targetAim`) reaches it: `out` when the point
 * it meets the target (`targetBody`) lies past the reach, `falloff` when the round meets it after the damage has started to fall,
 * `full` otherwise. Walls are not range; this is reach only.
 */
export function reachClass(r: Reach, from: { x: number; y: number }, at: { x: number; y: number }, kind: TargetKind): ReachClass {
  const aim = targetAim(kind, at), body = targetBody(kind, at);
  const dx = aim.x - from.x, dy = aim.y - from.y;
  const edge = Math.hypot(dx, dy) * (segmentEntersCapsuleAt(from.x, from.y, dx, dy, body.x, body.y, body.up, body.r) ?? 1);
  if (edge > r.reach) return 'out';
  return r.falloff && edge > r.falloff.start ? 'falloff' : 'full';
}

// ---------------------------------------------------------------------------------------------------------------- drawing

type View = { x0: number; y0: number; x1: number; y1: number };
type Me = { x: number; y: number; gun: GunId };

/** A change of gun slides the arc to its new reach (anticipation-free snap and settle, 200 ms); reduced motion jumps. */
const SLIDE_MS = 200;
let shown: { key: string; from: number; to: number; at: number; stampAt: number } | null = null;
const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

export function resetRangeLine() { shown = null; }

/** The reach drawn this frame: the gun's own once the slide is over. Also stamps the plate when the gun or its reach changes. */
export function shownReach(r: Reach, now: number): number {
  const key = `${r.gun}|${r.reach}`;
  if (!shown) shown = { key, from: r.reach, to: r.reach, at: -Infinity, stampAt: -Infinity };
  else if (shown.key !== key) {
    const cur = shown.from + (shown.to - shown.from) * easeOut((now - shown.at) / SLIDE_MS);
    shown = { key, from: cur, to: r.reach, at: now, stampAt: now };
  }
  if (reducedMotion()) return r.reach;
  return shown.from + (shown.to - shown.from) * easeOut((now - shown.at) / SLIDE_MS);
}

/** The lane field the marking is painted inside: from the firing line east, across every lane. */
function laneField(layout: RangeLayout, size: number) {
  return { x0: layout.line, x1: size - 60, y0: layout.lanes[0]!.y0, y1: layout.lanes.at(-1)!.y1 };
}

/** Floor paint, under every body: the falloff band and the dotted reach arc, clipped to the lanes. */
export function drawReachFloor(g: CanvasRenderingContext2D, layout: RangeLayout, size: number, view: View, me: Me, r: Reach, now: number) {
  const field = laneField(layout, size);
  const reach = shownReach(r, now);
  const k = reach / r.reach;
  if (me.x + reach < field.x0 || me.x - reach > field.x1) return;
  g.save();
  g.beginPath();
  g.rect(Math.max(field.x0, view.x0), Math.max(field.y0, view.y0), Math.min(field.x1, view.x1) - Math.max(field.x0, view.x0), Math.min(field.y1, view.y1) - Math.max(field.y0, view.y0));
  g.clip();
  g.lineCap = 'round';
  if (r.falloff) {
    const a = r.falloff.start * k, b = r.falloff.end * k;
    // The band: a faint orange wash where each round loses damage, edged with dotted floor paint.
    g.fillStyle = 'rgba(255, 90, 31, 0.08)';
    g.beginPath();
    g.arc(me.x, me.y, b, 0, Math.PI * 2);
    g.arc(me.x, me.y, a, 0, Math.PI * 2, true);
    g.fill('evenodd');
    g.strokeStyle = MUSTARD;
    g.globalAlpha = 0.55;
    g.lineWidth = 3;
    g.setLineDash([2, 12]);
    for (const rad of [a, b]) { g.beginPath(); g.arc(me.x, me.y, rad, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
  }
  // The reach: chunky signal-orange dashes on an ink under-stroke, like tape on the floor.
  g.setLineDash([18, 13]);
  g.lineDashOffset = 0;
  g.strokeStyle = INK;
  g.globalAlpha = 0.75;
  g.lineWidth = 9;
  g.beginPath(); g.arc(me.x, me.y, reach, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1;
  g.strokeStyle = ORANGE;
  g.lineWidth = 5;
  g.beginPath(); g.arc(me.x, me.y, reach, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.restore();
}

/**
 * One chip under a target, a toy token in ink: a filled orange disc with an ink tick (reached at full damage), half orange and half ink
 * (reached, but in the falloff), or a dark gunmetal disc with a bone cross (the round dies short).
 */
function pip(g: CanvasRenderingContext2D, x: number, y: number, c: ReachClass, u: number) {
  const rad = Math.max(7, 6 * u);
  const line = Math.max(2, 1.6 * u);
  g.lineWidth = line;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = INK;
  g.fillStyle = 'rgba(10, 12, 18, 0.42)';
  g.beginPath(); g.arc(x + 1.5 * u, y + 1.5 * u, rad, 0, Math.PI * 2); g.fill();
  if (c === 'full') {
    g.fillStyle = ORANGE;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); g.stroke();
    g.lineWidth = line * 1.15;
    g.beginPath(); g.moveTo(x - rad * 0.45, y + rad * 0.02); g.lineTo(x - rad * 0.1, y + rad * 0.38); g.lineTo(x + rad * 0.48, y - rad * 0.36); g.stroke();
  } else if (c === 'falloff') {
    g.fillStyle = INK;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    g.fillStyle = ORANGE;
    g.beginPath(); g.arc(x, y, rad, Math.PI * 0.75, Math.PI * 1.75); g.closePath(); g.fill();
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.stroke();
  } else {
    g.fillStyle = GUNMETAL;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = '#cfc7b3';
    g.lineWidth = line * 0.95;
    const k = rad * 0.36;
    g.beginPath(); g.moveTo(x - k, y - k); g.lineTo(x + k, y + k); g.moveTo(x + k, y - k); g.lineTo(x - k, y + k); g.stroke();
  }
}

function clippedPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cut: number) {
  g.beginPath();
  g.moveTo(x, y); g.lineTo(x + w - cut, y); g.lineTo(x + w, y + cut); g.lineTo(x + w, y + h); g.lineTo(x + cut, y + h); g.lineTo(x, y + h - cut);
  g.closePath();
}

/**
 * Over the world (after the light pass, like the zone flags): each standing target's pip and the plate at the arc's far point.
 * `screen` is the world rectangle actually on screen and `scale` the camera's, so the plate keeps one size on any screen; when the
 * far point is off the right edge the plate pins to that edge with a chevron pointing on to it.
 */
export function drawReachOverlay(
  g: CanvasRenderingContext2D, layout: RangeLayout, size: number, targets: readonly number[], serverMs: number, screen: View, scale: number, me: Me, r: Reach, now: number,
) {
  const u = 1 / Math.max(0.05, scale);
  /** Each standing target's footprint on screen, board to chip, so the plate never sits on one. */
  const boxes: View[] = [];
  for (const [i, def] of layout.targets.entries()) {
    if (!targets[i]) continue;
    const p = targetPos(def, serverMs);
    if (p.x < screen.x0 - 40 || p.x > screen.x1 + 40 || p.y < screen.y0 - 100 || p.y > screen.y1 + 40) continue;
    const chipY = p.y + TARGETS[def.kind].r * 0.62 + 8;
    boxes.push({ x0: p.x - 34, y0: p.y - 100, x1: p.x + 34, y1: chipY + 8 * u });
    pip(g, p.x, chipY, reachClass(r, me, p, def.kind), u);
  }
  const field = laneField(layout, size);
  const reach = shownReach(r, now);
  const apex = me.x + reach;
  if (apex < field.x0 || apex > field.x1 || me.y < field.y0 || me.y > field.y1) return;
  // The plate: the gun's range in bone on gunmetal, the falloff under it in grey, an orange bar down its left edge.
  const big = 15 * u, small = 13 * u, padX = 10 * u, padY = 6 * u, gap = 3 * u;
  g.save();
  g.font = `800 ${big}px ${FONT}`;
  const w1 = g.measureText(r.title).width;
  g.font = `700 ${small}px ${FONT}`;
  const w2 = r.sub ? g.measureText(r.sub).width : 0;
  const chevW = 9 * u;
  // Off the right edge it pins there with a chevron; otherwise it takes the first spot beside the far point that covers no target.
  const pinned = apex > screen.x1 - 24 * u;
  const w = Math.max(w1, w2) + padX * 2 + (pinned ? chevW + 4 * u : 0);
  const h = padY * 2 + big + (r.sub ? gap + small : 0);
  // Clear of the HUD's top band (readout, mode pill, board) and its bottom corners (health, minimap) on a desktop and a phone alike.
  const top = screen.y0 + 110 * u, bottom = screen.y1 - h - 110 * u;
  const spots: { x: number; y: number; foot: number; footY: number }[] = [];
  for (const dy of [-h - 18 * u, 18 * u, -h - 70 * u, 70 * u]) {
    for (const side of pinned ? [0] : [1, -1]) {
      const x = side === 0 ? screen.x1 - 12 * u - w : side > 0 ? apex + 14 * u : apex - 14 * u - w;
      if (side !== 0 && (x < screen.x0 + 12 * u || x + w > screen.x1 - 12 * u)) continue;
      const y = Math.min(bottom, Math.max(top, me.y + dy));
      spots.push({ x, y, foot: side > 0 ? x + 8 * u : x + w - 8 * u, footY: y + h / 2 < me.y ? y + h : y });
    }
  }
  if (!spots.length) spots.push({ x: apex - 14 * u - w, y: Math.min(bottom, Math.max(top, me.y - h - 18 * u)), foot: apex - 16 * u, footY: me.y });
  const clear = (o: { x: number; y: number }) => !boxes.some((b) => o.x < b.x1 && o.x + w > b.x0 && o.y < b.y1 && o.y + h > b.y0);
  const { x, y, foot, footY } = spots.find(clear) ?? spots[0]!;
  if (!pinned) {
    // A leader from the plate to the arc's far point, and a dot on it.
    g.lineCap = 'round';
    g.strokeStyle = INK; g.lineWidth = 5 * u;
    g.beginPath(); g.moveTo(apex, me.y); g.lineTo(foot, footY); g.stroke();
    g.strokeStyle = ORANGE; g.lineWidth = 2.5 * u;
    g.beginPath(); g.moveTo(apex, me.y); g.lineTo(foot, footY); g.stroke();
    g.fillStyle = ORANGE; g.strokeStyle = INK; g.lineWidth = 2 * u;
    g.beginPath(); g.arc(apex, me.y, 5 * u, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  // A gun change stamps the plate: it swells a step and settles (snap and settle, 220 ms).
  const st = reducedMotion() || !shown || now - shown.stampAt >= 220 ? 1 : 1 + 0.12 * (1 - easeOut((now - shown.stampAt) / 220));
  g.translate(x + w / 2, y + h / 2);
  g.scale(st, st);
  g.translate(-(x + w / 2), -(y + h / 2));
  const cut = 6 * u;
  g.fillStyle = 'rgba(5, 6, 9, 0.5)';
  clippedPath(g, x + 3 * u, y + 3 * u, w, h, cut); g.fill();
  g.fillStyle = GUNMETAL;
  clippedPath(g, x, y, w, h, cut); g.fill();
  g.save(); g.clip(); g.fillStyle = '#4c535f'; g.fillRect(x, y, w, 3 * u); g.fillStyle = ORANGE; g.fillRect(x, y, 3 * u, h); g.restore();
  g.lineWidth = 2 * u; g.lineJoin = 'round'; g.strokeStyle = INK;
  clippedPath(g, x, y, w, h, cut); g.stroke();
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.font = `800 ${big}px ${FONT}`;
  g.fillStyle = BONE;
  g.fillText(r.title, x + padX, y + padY);
  if (r.sub) {
    g.font = `700 ${small}px ${FONT}`;
    g.fillStyle = MUTED;
    g.fillText(r.sub, x + padX, y + padY + big + gap);
  }
  if (pinned) {
    const cx = x + w - padX - chevW / 2, cy = y + h / 2;
    g.strokeStyle = ORANGE; g.lineWidth = 3 * u; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(cx - chevW * 0.3, cy - chevW * 0.6); g.lineTo(cx + chevW * 0.35, cy); g.lineTo(cx - chevW * 0.3, cy + chevW * 0.6); g.stroke();
  }
  g.restore();
}
