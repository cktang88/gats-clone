import { isTurretKind, WORLD, ZOM, type BuildingKind } from '../shared/defs.ts';
import type { BuildingView, PlayerView, RunView, Snapshot, ZombieView } from '../shared/protocol.ts';
import { cellRect, coreRectAt, costOf, levelOf, maxLevelOf } from '../shared/sim/build.ts';
import { clock } from './derive.ts';
import { HIT_FLASH_MS } from './effects.ts';
import { INK, PALETTE, tint } from './palette.ts';
import { drawFallenSoldier } from './bodies.ts';
import { cosLook } from './cosmeticlook.ts';
import { CORE_GLOW, drawCoreBody } from './coreart.ts';
import { coreFlash, onStrike, siege } from './siegefx.ts';
import { animateZombies, biteTarget, cellId, drawHorde } from './zombieart.ts';
import type { Effect } from './state.ts';
import { buildingSolid, drawSolids, LIGHT, standsUp } from './tilt.ts';
import type { Ghost } from './zombies.ts';
import type { Rect } from '../shared/sim/movement.ts';
import { drawPips, drawTurret, drawTurretLit } from './turretart.ts';
import { drawRangeRings, rangeRings } from './turretrange.ts';

const TAU = Math.PI * 2;

/** What stands on a raised pad: walls (as their tier), depots and posts. A turret is an emplacement sandbagged straight onto the floor (turretart.ts), so it is no block. */
export const onPad = (b: BuildingView): boolean => standsUp(b) && !isTurretKind(b.kind);
const R = WORLD.playerRadius;

export const CORE_ALERT_MS = 1500;

/** When the core was last bitten, for the alert. Only the night can bite it, so dawn and the report clear the alert at once. */
export function nextCoreHitAt(prev: RunView | null | undefined, run: RunView | null | undefined, now: number, hitAt: number): number {
  if (run?.phase !== 'night') return -Infinity;
  return prev && run.core.hp < prev.core.hp ? now : hitAt;
}

/** Damage numbers and impact effects name walls by their center, since a wall's view carries no id. */
const cellKey = (x: number, y: number) => `${Math.floor(x / ZOM.cell)},${Math.floor(y / ZOM.cell)}`;

export function wallFlashes(effects: readonly Effect[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const fx of effects) if (fx.kind === 'impact' && fx.surface === 'building' && now - fx.born < HIT_FLASH_MS) out.set(cellKey(fx.x, fx.y), fx.born);
  return out;
}

/** `to` is the angle of the turret's last shot (fired at `firedAt`), and `drawn` eases toward it, last eased at `at`. */
export type TurretAim = { to: number; drawn: number; at: number; firedAt: number };

/** A turret turns only to fire, so each shot's angle is its aim until the next; aims of turrets gone from the snapshot are dropped. */
export function aimTurrets(aims: Map<string, TurretAim>, snap: Snapshot, now: number) {
  for (const ev of snap.events) {
    // A coil never turns: its discharge only stamps when it fired, for its crown of sparks.
    if (ev.e === 'coil') { const key = cellKey(ev.x, ev.y), aim = aims.get(key); if (aim) aim.firedAt = now; else aims.set(key, { to: 0, drawn: 0, at: now, firedAt: now }); continue; }
    if (ev.e !== 'turret') continue;
    const key = cellKey(ev.x, ev.y), aim = aims.get(key);
    if (aim) { aim.to = ev.angle; aim.firedAt = now; } else aims.set(key, { to: ev.angle, drawn: ev.angle, at: now, firedAt: now });
  }
  if (!snap.buildings) return;
  const standing = new Set(snap.buildings.map((b) => `${b.cx},${b.cy}`));
  for (const key of aims.keys()) if (!standing.has(key)) aims.delete(key);
}

const TURN_PER_SEC = 14;

const awayFromCore = (b: Pick<BuildingView, 'cx' | 'cy'>, core: { x: number; y: number }) => Math.atan2((b.cy + 0.5) * ZOM.cell - core.y, (b.cx + 0.5) * ZOM.cell - core.x);

/** The barrel's drawn angle eases toward its aim, and how long ago it last fired; a turret that never fired faces away from the core. */
function barrelOf(aims: Map<string, TurretAim>, b: BuildingView, core: { x: number; y: number }, now: number): { angle: number; sinceShot: number } {
  const aim = aims.get(`${b.cx},${b.cy}`);
  if (!aim) return { angle: awayFromCore(b, core), sinceShot: Infinity };
  if (b.kind === 'tesla') return { angle: 0, sinceShot: now - aim.firedAt };
  const d = aim.to - aim.drawn;
  aim.drawn += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, ((now - aim.at) / 1000) * TURN_PER_SEC);
  aim.at = now;
  return { angle: aim.drawn, sinceShot: now - aim.firedAt };
}

/** A raised box seen three-quarter: its top face, then a darker front face hanging below it, each ink-edged, with a lit top edge. */
function box3d(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, depth: number, top: string, front: string) {
  ctx.fillStyle = front;
  ctx.fillRect(x, y + h, w, depth);
  ctx.fillStyle = top;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = tint(top, 0.24);
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = tint(top, -0.3);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeRect(x, y + h, w, depth);
}

/** An ammo depot: two olive ammo crates, one stacked on the other, with an orange band and a stencilled round on the front. */
function drawDepot(ctx: CanvasRenderingContext2D, cx: number, cy: number, lv: number) {
  box3d(ctx, cx - 17, cy - 7, 24, 14, 8, '#6c7356', '#4f5640');
  ctx.fillStyle = '#e0661f';
  ctx.fillRect(cx - 17, cy + 8, 24, 3);
  box3d(ctx, cx + 1, cy - 15, 17, 11, 6, '#7a8262', '#59614a');
  ctx.fillStyle = 'rgba(20, 22, 26, 0.75)';
  ctx.beginPath();
  ctx.roundRect(cx - 7, cy - 4, 4, 9, 2);
  ctx.fill();
  ctx.fillStyle = '#ffb347';
  ctx.fillRect(cx - 7, cy + 1, 4, 4);
  // More levels, more stock: a third crate, then a fourth on the ground by the stack.
  if (lv >= 2) box3d(ctx, cx - 17, cy - 15, 14, 8, 4, '#7a8262', '#59614a');
  if (lv >= 3) box3d(ctx, cx + 9, cy + 6, 12, 7, 4, '#6c7356', '#4f5640');
}

/** A repair post: a gunmetal locker with a green cross plate, an antenna and a lamp that blinks green, a bigger cross at each level. */
function drawPost(ctx: CanvasRenderingContext2D, cx: number, cy: number, lv: number, now: number) {
  const w = 22 + 2 * lv, h = 16 + 2 * lv;
  box3d(ctx, cx - w / 2, cy - h / 2 - 3, w, h, 9, '#4f5560', '#383d46');
  const fy = cy - h / 2 - 3 + h;
  ctx.fillStyle = '#2f9e6f';
  ctx.fillRect(cx - 6, fy + 1.2, 12, 6.6);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - 1.2, fy + 1.8, 2.4, 5.4);
  ctx.fillRect(cx - 3.2, fy + 3.4, 6.4, 2.4);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(cx - 6, fy + 1.2, 12, 6.6);
  ctx.beginPath();
  ctx.moveTo(cx + w / 2 - 5, cy - h / 2 - 3);
  ctx.lineTo(cx + w / 2 - 5, cy - h / 2 - 12);
  ctx.stroke();
  ctx.fillStyle = Math.floor(now / 500) % 2 ? '#8ff0c4' : '#2f7a58';
  ctx.beginPath();
  ctx.arc(cx + w / 2 - 5, cy - h / 2 - 13, 2.6, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // The cross plate on top, white on green, lit when the post is in the middle of a mend.
  ctx.fillStyle = '#2f9e6f';
  ctx.fillRect(cx - w / 2 + 3, cy - h / 2 - 1, 7, 7);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - w / 2 + 5.8, cy - h / 2, 1.4, 5);
  ctx.fillRect(cx - w / 2 + 4, cy - h / 2 + 1.8, 5, 1.4);
}

/** What stands on a cell, drawn over its pad (centred on `cx`, `cy`): a turret's emplacement and gun turned to `angle` (turretart.ts), a coil, a depot's crates or a post's locker. */
function drawHead(ctx: CanvasRenderingContext2D, b: { kind: BuildingKind; lv?: number; hp: number }, cx: number, cy: number, angle: number, sinceShot: number, now: number, pxPerUnit: number) {
  const lv = levelOf(b);
  if (b.kind === 'depot') drawDepot(ctx, cx, cy, lv);
  else if (b.kind === 'post') drawPost(ctx, cx, cy, lv, now);
  else if (isTurretKind(b.kind)) drawTurret(ctx, { kind: b.kind, lv, hp: b.hp, x: cx, y: cy, angle, sinceShot }, pxPerUnit);
}

/** A spike strip: a steel rail with a row of spikes standing up from it, ink-edged, lit on one side and shaded on the other, fewer of them as it is trampled. */
export function drawSpikes(ctx: CanvasRenderingContext2D, b: BuildingView, now: number) {
  const { x, y, w, h } = cellRect(b.cx, b.cy);
  const n = Math.max(3, Math.ceil((7 * b.hp) / 10)), left = x + 4, span = w - 8, railY = y + h / 2 + 4;
  void now;
  ctx.fillStyle = 'rgba(20, 22, 28, 0.3)';
  ctx.fillRect(left + LIGHT.x * 5, railY + 3, span, 5);
  ctx.fillStyle = b.hp <= 3 ? '#6a5645' : '#555c67';
  ctx.fillRect(left, railY - 3, span, 6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.fillRect(left, railY - 3, span, 1.6);
  ctx.fillStyle = 'rgba(10, 12, 16, 0.32)';
  ctx.fillRect(left, railY + 1.6, span, 1.4);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(left, railY - 3, span, 6);
  const step = span / n;
  for (let i = 0; i < n; i++) {
    const sx = left + step * (i + 0.5), hgt = 13 - (i % 2) * 2;
    ctx.beginPath();
    ctx.moveTo(sx - 3.4, railY - 3); ctx.lineTo(sx, railY - 3 - hgt); ctx.lineTo(sx + 3.4, railY - 3); ctx.closePath();
    ctx.fillStyle = '#9aa3b0';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx, railY - 3 - hgt); ctx.lineTo(sx + 3.4, railY - 3); ctx.lineTo(sx, railY - 3); ctx.closePath();
    ctx.fillStyle = 'rgba(10, 12, 16, 0.32)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx - 3.4, railY - 3); ctx.lineTo(sx, railY - 3 - hgt); ctx.lineTo(sx + 3.4, railY - 3); ctx.closePath();
    ctx.stroke();
  }
}

/** Floor items lie under bodies, so they are drawn before the horde and the squad. */
export function drawFloorItems(ctx: CanvasRenderingContext2D, items: readonly BuildingView[], now: number) {
  for (const b of items) if (b.kind === 'spikes') drawSpikes(ctx, b, now);
}

export function drawSiegeTops(
  ctx: CanvasRenderingContext2D, buildings: readonly BuildingView[], flashes: ReadonlyMap<string, number>, aims: Map<string, TurretAim>, core: { x: number; y: number }, now: number, pxPerUnit: number,
) {
  for (const b of buildings) {
    const { x, y, w, h } = cellRect(b.cx, b.cy);
    if (b.kind !== 'wall') {
      const barrel = barrelOf(aims, b, core, now);
      drawHead(ctx, b, x + w / 2, y + h / 2, barrel.angle, barrel.sinceShot, now, pxPerUnit);
    }
    const hit = flashes.get(`${b.cx},${b.cy}`);
    if (hit !== undefined) {
      ctx.globalAlpha = 0.7 * (1 - (now - hit) / HIT_FLASH_MS);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    }
  }
}

/** The sim's cover (turrets.ts aims past walls and crates), as one array that only changes when the walls or crates do, so blind spots are worked out once. */
let cover: { walls: readonly Rect[]; crates: string; rects: Rect[] } | null = null;
function coverOf(walls: readonly Rect[], crates: readonly { x: number; y: number; size: number }[]): Rect[] {
  const key = crates.map((c) => `${c.x},${c.y}`).join(';');
  if (!cover || cover.walls !== walls || cover.crates !== key) cover = { walls, crates: key, rects: [...walls, ...crates.map((c) => ({ x: c.x, y: c.y, w: c.size, h: c.size }))] };
  return cover.rects;
}

/** What the lit pass over the night needs to draw the siege's lights and turret ranges this frame. */
export type SiegeLights = {
  /** Standing buildings in view. */
  buildings: readonly BuildingView[];
  /** Every building, for the rings (a turret's ring reaches into view from off screen). */
  all: readonly BuildingView[];
  aims: Map<string, TurretAim>;
  core: { x: number; y: number };
  day: boolean;
  ghost: Ghost | null;
  cursor: { x: number; y: number } | null;
  upgrade: BuildingView | null;
  /** The night's faint rings round every turret: the Turret ranges setting, once it is dark. */
  squadRings: boolean;
  /** The map's walls and crates: the cover a direct-fire turret cannot see through. */
  walls: readonly Rect[];
  crates: readonly { x: number; y: number; size: number }[];
  now: number;
  pxPerUnit: number;
  scale: number;
  reduced: boolean;
  /** How dark the night is, 0..1. */
  dark: number;
};

/**
 * The siege's lit layer, drawn over the night's shade: turret ranges (turretrange.ts), then on each turret what it lights
 * (muzzle flash and floor pool, status lamp, ammo gauge, the coil's orb; turretart.ts), then every building's level pips,
 * so a turret reads at a glance in the dark.
 */
export function drawSiegeLights(ctx: CanvasRenderingContext2D, l: SiegeLights) {
  const rings = rangeRings({ ghost: l.ghost, buildings: l.all, day: l.day, cursor: l.cursor, upgrade: l.upgrade, squad: l.squadRings });
  if (rings.length) drawRangeRings(ctx, rings, coverOf(l.walls, l.crates), l.scale, l.now, l.reduced);
  for (const b of l.buildings) {
    if (b.kind === 'wall') continue;
    const { x, y, w, h } = cellRect(b.cx, b.cy);
    if ('ammo' in b) {
      const aim = l.aims.get(`${b.cx},${b.cy}`);
      const angle = !aim ? awayFromCore(b, l.core) : b.kind === 'tesla' ? 0 : aim.drawn;
      drawTurretLit(ctx, { kind: b.kind, lv: levelOf(b), hp: b.hp, x: x + w / 2, y: y + h / 2, angle, sinceShot: aim ? l.now - aim.firedAt : Infinity, ammo: b.ammo }, l.now, l.pxPerUnit, l.reduced, l.dark);
    }
    drawPips(ctx, levelOf(b), maxLevelOf(b.kind), x, y);
  }
}

/**
 * The Bastion's ground, under everything: a hazard-taped ring painted round it on the floor, the kit's orange on ink, and a
 * cool underglow that breathes with its crystal. The light it gives off is drawn later, over the night (siegefx.ts).
 */
export function drawCoreGlow(ctx: CanvasRenderingContext2D, run: RunView, now: number) {
  const { x, y } = run.core;
  const pulse = 0.5 + 0.5 * Math.sin(now / 420);
  ctx.globalAlpha = 0.05 + 0.04 * pulse;
  ctx.fillStyle = CORE_GLOW;
  ctx.beginPath();
  ctx.arc(x, y, 104, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 8;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, 104, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([10, 10]);
  ctx.lineDashOffset = 0;
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#d9541f';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawCoreTop(ctx: CanvasRenderingContext2D, run: RunView, now: number, hitAt: number, pxPerUnit = 1) {
  drawCoreBody(ctx, run, now, coreFlash(siege, hitAt, now), pxPerUnit);
}

/**
 * The horde: each zombie's walk and bite advanced from where it is drawn (zombieart.ts), each blow that lands on the core, a
 * building or a squad player bursting sparks and chips off it (siegefx.ts), then the horde drawn batched by kind.
 */
export function drawZombies(ctx: CanvasRenderingContext2D, zombies: readonly ZombieView[], snap: Pick<Snapshot, 'run' | 'buildings' | 'players'>, flashes: ReadonlyMap<number, number>, now: number, pxPerUnit: number) {
  const core = snap.run ? coreRectAt(snap.run.core) : null;
  const buildingAt = new Map((snap.buildings ?? []).filter((b) => b.kind !== 'spikes').map((b) => [cellId(b.cx, b.cy), b]));
  const players = snap.players.filter((p) => p.alive).map((p) => ({ x: p.x, y: p.y, r: R }));
  animateZombies(zombies, now, snap.run?.core ?? { x: 0, y: 0 }, (kind, x, y) => biteTarget(kind, x, y, core, buildingAt, players), (st) => onStrike(siege, st, now));
  drawHorde(ctx, zombies, flashes, now, pxPerUnit);
}

/**
 * A downed squadmate: their own soldier lying where they fell, in their colour (they are not dead yet), reaching and
 * struggling; a ring on the floor pulsing red faster as they bleed out; round them the bleed-out draining and, once someone
 * holds use, the revive filling in green; a medic plate bobbing over them; and the time left.
 */
export function drawDowned(ctx: CanvasRenderingContext2D, p: PlayerView, color: string, serverNow: number | null, self: boolean, now = 0, pxPerUnit = 1) {
  const down = p.downed;
  if (!down) return;
  const left = serverNow === null ? ZOM.bleedOutMs : Math.max(0, down.bleedOutAt - serverNow);
  const urgency = 1 - Math.min(1, left / ZOM.bleedOutMs);
  const beat = 0.5 + 0.5 * Math.sin(now / (260 - 150 * urgency));
  // The pulse on the floor, under the body.
  ctx.globalAlpha = (0.18 + 0.22 * beat) * (down.revive > 0 ? 0.4 : 1);
  ctx.fillStyle = down.revive > 0 ? PALETTE.hpGood : PALETTE.hpBad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, R + 8 + 5 * beat, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  const struggle = Math.sin(now / 320 + p.id) * 0.25;
  drawFallenSoldier(ctx, color, p.x, p.y, R, { angle: p.angle, splay: [0.5 + struggle, 0.7 - struggle], loll: 0.15 * Math.sin(now / 500 + p.id), scale: 1, helmet: cosLook(p.cos).helmet, camo: cosLook(p.cos).camo }, pxPerUnit);
  // Bleed-out draining, then the revive filling over it.
  const ring = R + 12;
  ctx.lineCap = 'butt';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(28, 31, 38, 0.55)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, ring, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = left < 8000 ? PALETTE.hunted : '#ff9f43';
  ctx.beginPath();
  ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + (1 - urgency) * TAU);
  ctx.stroke();
  if (down.revive > 0) {
    ctx.lineWidth = 5;
    ctx.strokeStyle = PALETTE.hpGood;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + down.revive * TAU);
    ctx.stroke();
  }
  if (self) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring + 5, 0, TAU);
    ctx.stroke();
  }
  // The medic plate: a white cross on the kit's green, ink-edged, bobbing.
  const mx = p.x, my = p.y - R - 30 + Math.sin(now / 300) * 2;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(mx, my, 9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = down.revive > 0 ? PALETTE.hpGood : tint(PALETTE.hpBad, 0.1 * beat);
  ctx.beginPath();
  ctx.arc(mx, my, 7.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(mx - 1.6, my - 4.5, 3.2, 9);
  ctx.fillRect(mx - 4.5, my - 1.6, 9, 3.2);
  if (serverNow !== null) {
    ctx.font = '750 12px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(28, 31, 38, 0.8)';
    ctx.strokeText(clock(left), p.x, p.y + R + 24);
    ctx.fillStyle = left < 8000 ? PALETTE.hunted : '#ffffff';
    ctx.fillText(clock(left), p.x, p.y + R + 24);
  }
}

const GHOST_LOOK = { ok: PALETTE.hpGood, no: PALETTE.hpBad, down: '#ff9f43' } as const;

/** One cell of the ghost: the building seen through where it would stand (unless one stands there), washed and edged in `color`. */
function drawGhostCell(ctx: CanvasRenderingContext2D, ghost: Ghost, cx: number, cy: number, color: string, preview: boolean, core: { x: number; y: number }, now: number, pxPerUnit: number) {
  const { x, y, w, h } = cellRect(cx, cy);
  if (preview) {
    ctx.globalAlpha = 0.6;
    const at = { cx, cy, hp: 10, kind: ghost.kind, lv: ghost.lv } as BuildingView;
    if (ghost.kind === 'spikes') drawSpikes(ctx, at, now);
    else {
      if (onPad(at)) drawSolids(ctx, [buildingSolid(at)]);
      if (ghost.kind !== 'wall') drawHead(ctx, at, x + w / 2, y + h / 2, awayFromCore(at, core), Infinity, now, pxPerUnit);
    }
  }
  ctx.globalAlpha = 0.3 + 0.1 * Math.sin(now / 160);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
}

/** The ghost previews the chosen tier or kind where it would stand, seen through, then a plate naming it (and, over a building, its level, health and upgrade). */
export function drawGhost(ctx: CanvasRenderingContext2D, ghost: Ghost, self: { x: number; y: number }, core: { x: number; y: number }, now: number, pxPerUnit: number) {
  ctx.setLineDash([12, 10]);
  ctx.lineDashOffset = -now / 60;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 90, 31, 0.7)';
  ctx.beginPath();
  ctx.arc(core.x, core.y, ZOM.buildRadius, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(40, 44, 52, 0.45)';
  ctx.beginPath();
  ctx.arc(self.x, self.y, ZOM.reachPx, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  const { x, y, w } = cellRect(ghost.cx, ghost.cy);
  const color = ghost.refusal === null ? GHOST_LOOK.ok : ghost.refusal === 'taken' ? GHOST_LOOK.down : GHOST_LOOK.no;
  if (ghost.line) {
    // A dragged line: every cell its own ghost, green where it goes up and red where it is passed over, each tagged with what it costs.
    const cost = costOf(ghost.kind, ghost.lv);
    for (const c of ghost.line) drawGhostCell(ctx, ghost, c.cx, c.cy, c.refusal === null ? GHOST_LOOK.ok : GHOST_LOOK.no, c.refusal !== 'taken', core, now, pxPerUnit);
    ctx.font = '800 13px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const c of ghost.line) {
      const at = cellRect(c.cx, c.cy);
      ctx.strokeStyle = 'rgba(28, 31, 38, 0.85)';
      ctx.strokeText(`${cost}`, at.x + at.w / 2, at.y + at.h / 2);
      ctx.fillStyle = c.refusal === null ? '#ffffff' : '#ffb3a8';
      ctx.fillText(`${cost}`, at.x + at.w / 2, at.y + at.h / 2);
    }
  } else drawGhostCell(ctx, ghost, ghost.cx, ghost.cy, color, ghost.refusal !== 'taken', core, now, pxPerUnit);
  if (!ghost.label) return;
  const lines = ghost.detail ? [ghost.label, ghost.detail] : [ghost.label];
  // The plate is drawn in the world, so zoomed out it grows to stay readable.
  const t = Math.min(1.8, Math.max(1, (globalThis.devicePixelRatio || 1) / ctx.getTransform().a));
  ctx.font = `800 ${14 * t}px "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16 * t, lh = (12 + lines.length * 14) * t;
  // The interface's plate: gunmetal with its top-right and bottom-left corners clipped.
  const lx = x + w / 2 - lw / 2, ly = y - 10 - lh, c = 6 * t;
  ctx.fillStyle = 'rgba(30, 33, 40, 0.9)';
  ctx.beginPath();
  ctx.moveTo(lx, ly); ctx.lineTo(lx + lw - c, ly); ctx.lineTo(lx + lw, ly + c); ctx.lineTo(lx + lw, ly + lh); ctx.lineTo(lx + c, ly + lh); ctx.lineTo(lx, ly + lh - c);
  ctx.closePath();
  ctx.fill();
  lines.forEach((l, i) => {
    ctx.font = `${i === 0 ? 800 : 600} ${(i === 0 ? 14 : 13) * t}px "Barlow Condensed", system-ui, sans-serif`;
    ctx.fillStyle = i === 0 ? (color === GHOST_LOOK.ok ? '#ffffff' : color) : '#cfc9b8';
    ctx.fillText(l, x + w / 2, ly + (6 + 7 + i * 14) * t);
  });
}
