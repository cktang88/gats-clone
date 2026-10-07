import { COLORS, GUNS, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES } from '../shared/defs.ts';
import { MAPS, CRATE_SIZE } from '../shared/maps.ts';
import type { BulletView, PlayerView, RunView, Snapshot, ThrownView, WallView, ZoneView } from '../shared/protocol.ts';
import { BLAST_RADIUS } from '../shared/sim/abilities.ts';
import { screenToWorld, type Camera, type Point } from './camera.ts';
import { drawCasings, drawEffects, drawParticles, HIT_FLASH_MS, hitFlashes, kicks, KICK_MS } from './effects.ts';
import { NUMBER_MS, numberHeight, type DamageNumber } from './feedback.ts';
import { ARMOR_RIM, glow, INK, NIGHT, PALETTE, TEAM_COLORS, teamColor } from './palette.ts';
import { serverNow } from './interp.ts';
import { drawCoreGlow, drawCoreTop, drawDowned, drawGhost, drawSiegeTops, drawZombies, faceZombies, wallFlashes } from './siege.ts';
import { bodySprite, drawBody, drawBodyShadows } from './bodies.ts';
import { drawGun } from './sprites.ts';
import type { Session } from './state.ts';
import { buildingSolid, coreSolid, crateSolid, createGroundCache, curbSolids, drawGround, drawLooseShadows, drawSolids, LIP, wallSolids, type Solid } from './tilt.ts';
import type { Ghost } from './zombies.ts';
import { trailDashes, type TrailPoint } from './trails.ts';
import { TRACER } from './rounds.ts';
import { drawCracks, hostKey } from './decals.ts';

const TAU = Math.PI * 2;
const R = WORLD.playerRadius;
const GRID = 80;
const CULL_MARGIN = 80;

export const bodyColor = (p: Pick<PlayerView, 'color' | 'team'>): string => (p.team ? TEAM_COLORS[p.team] : COLORS[p.color]);

type Frame = { snap: Snapshot; s: Session; cam: Camera; dpr: number; now: number; selfAngle: number | null; killerId: number | null; ghost?: Ghost | null };
type View = { x0: number; y0: number; x1: number; y1: number };

const inView = (v: View, x: number, y: number, w: number, h: number) => x + w >= v.x0 && x <= v.x1 && y + h >= v.y0 && y <= v.y1;
const solidInView = (v: View, s: Solid) => inView(v, s.x, s.y, s.w + LIP, s.h + LIP);

const ground = createGroundCache();
const mapWallKeys = new WeakMap<readonly WallView[], string>();
export function mapWallsKey(walls: readonly WallView[]): string {
  let key = mapWallKeys.get(walls);
  if (key === undefined) mapWallKeys.set(walls, (key = walls.flatMap((w) => (w.built ? [] : [`${w.material}${w.x},${w.y},${w.w},${w.h}`])).join('|')));
  return key;
}
export const shadowBakes = ground.bakes;

let night = 0;
let nightAt = 0;
const NIGHT_FADE_MS = 1500;

export const nightAmount = () => night;

function easeNight(run: RunView | undefined, now: number): number {
  const target = run?.phase === 'night' ? 1 : 0;
  const step = Math.min(1, Math.max(0, now - nightAt) / NIGHT_FADE_MS);
  nightAt = now;
  night = night < target ? Math.min(target, night + step) : Math.max(target, night - step);
  return night;
}

export function drawWorld(ctx: CanvasRenderingContext2D, f: Frame) {
  const { cam, dpr, snap, s, now } = f;
  const k = dpr * cam.scale;
  ctx.setTransform(k, 0, 0, k, dpr * (cam.w / 2 - cam.x * cam.scale), dpr * (cam.h / 2 - cam.y * cam.scale));
  const tl = screenToWorld(cam, { x: 0, y: 0 });
  const br = screenToWorld(cam, { x: cam.w, y: cam.h });
  const view: View = { x0: tl.x - CULL_MARGIN, y0: tl.y - CULL_MARGIN, x1: br.x + CULL_MARGIN, y1: br.y + CULL_MARGIN };
  const dark = easeNight(snap.run, now);
  const siege = snap.run ? [...(snap.buildings ?? []).map(buildingSolid), coreSolid(snap.run)] : 'static';
  drawGround(ctx, ground.get(mapWallsKey(s.walls), s.worldSize, () => [...curbSolids(s.worldSize), ...wallSolids(s.walls.filter((w) => !w.built))], siege), view.x0, view.y0, view.x1, view.y1);
  drawGrid(ctx, s.worldSize, tl, br);

  const mine = snap.players.find((p) => p.id === s.myId);
  // The squad shares one team, so each squadmate wears their own color instead.
  const colorOf = (p: PlayerView) => (snap.run ? COLORS[p.color] : bodyColor(p));
  for (const [i, z] of snap.zones.entries()) drawZone(ctx, z, i);
  for (const t of snap.thrown) if (t.kind === 'landMine') drawThrown(ctx, t, now);
  if (snap.run) drawCoreGlow(ctx, snap.run, now);
  drawTrails(ctx, s.trails, now);

  const crates = snap.crates.map(crateSolid).filter((c) => solidInView(view, c));
  drawLooseShadows(ctx, [...crates, ...wallSolids(s.walls.filter((w) => w.built)).filter((w) => solidInView(view, w))]);
  drawCasings(ctx, s.particles, now);

  const alive = snap.players.filter((p) => p.alive && inView(view, p.x - R * 3, p.y - R * 3, R * 6, R * 6));
  const downed = snap.players.filter((p) => p.downed && inView(view, p.x - R * 3, p.y - R * 3, R * 6, R * 6));
  const zombies = snap.zombies ?? [];
  drawBodyShadows(ctx, [
    ...alive.filter((p) => !p.hidden).map((p) => ({ x: p.x, y: p.y, r: R })),
    ...zombies.map(([, kind, x, y]) => ({ x, y, r: ZOMBIES[ZOMBIE_KINDS[kind]].radius })),
  ], k);

  const walls = wallSolids(s.walls).filter((w) => solidInView(view, w));
  const standing = (siege === 'static' ? [] : siege).filter((b) => solidInView(view, b));
  drawSolids(ctx, [...curbSolids(s.worldSize).filter((c) => solidInView(view, c)), ...walls, ...standing, ...crates]);
  if (snap.buildings && snap.run) {
    drawSiegeTops(ctx, snap.buildings.filter((b) => inView(view, b.cx * ZOM.cell, b.cy * ZOM.cell, ZOM.cell, ZOM.cell)), wallFlashes(s.effects, now), s.turretAims, snap.run.core, now, k);
  }
  if (snap.run) drawCoreTop(ctx, snap.run, now, s.coreHitAt);
  drawCracks(ctx, s.cracks, now, new Set([...s.walls, ...crates, ...standing].map(hostKey)));
  if (dark > 0) drawNight(ctx, tl, br, dark);

  drawTracers(ctx, snap.bullets);

  const flashes = hitFlashes(s.effects, now);
  if (zombies.length) {
    faceZombies(s.zombieFaces, zombies, snap.run?.core ?? s.lastSelf);
    drawZombies(ctx, zombies, s.zombieFaces, flashes, now, k);
  }
  for (const p of downed) drawDowned(ctx, p, colorOf(p), serverNow(s.snaps, now), p.id === s.myId);
  const tags = bodyTags(alive, s, now);
  drawNamesUnderBodies(ctx, tags, dark);
  const recoil = kicks(s.effects, now);
  for (const p of alive) {
    const self = p.id === s.myId;
    const angle = self && f.selfAngle !== null ? f.selfAngle : p.angle;
    const flash = flashes.get(p.id);
    const kick = recoil.get(p.id);
    drawPlayer(ctx, { ...p, angle }, colorOf(p), {
      self, rival: !self && p.team === null && p.color === mine?.color,
      flash: flash === undefined ? 0 : 1 - (now - flash) / HIT_FLASH_MS, kick: kick === undefined ? 0 : 1 - (now - kick) / KICK_MS, now, pxPerUnit: k,
    });
  }
  for (const t of snap.thrown) if (t.kind !== 'landMine' && t.kind !== 'gasCloud') drawThrown(ctx, t, now);
  for (const t of snap.thrown) if (t.kind === 'gasCloud') drawThrown(ctx, t, now);
  drawEffects(ctx, s.effects, now);
  drawParticles(ctx, s.particles, now);
  drawBars(ctx, tags, dark);
  if (f.ghost && snap.run) drawGhost(ctx, f.ghost, s.lastSelf, snap.run.core, now, k);
  const killer = f.killerId === null ? undefined : alive.find((p) => p.id === f.killerId);
  if (killer) drawKillerMark(ctx, killer, now, dark);
  drawDamageNumbers(ctx, s.feedback.numbers, now);
}

/** A plain blend, since a multiply costs a software canvas over a millisecond a frame. */
function drawNight(ctx: CanvasRenderingContext2D, tl: Point, br: Point, dark: number) {
  ctx.globalAlpha = dark * NIGHT.alpha;
  ctx.fillStyle = NIGHT.shade;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.globalAlpha = 1;
}

const BACKDROP = { zoom: 0.75, swayMs: 40_000, fill: 0.85 } as const;
const BACKDROP_MAP = MAPS.plaza;
const backdropSolids: Solid[] = [...curbSolids(BACKDROP_MAP.size), ...wallSolids(BACKDROP_MAP.walls.map((w) => ({ ...w, built: false })))];
const backdropCrates: Solid[] = BACKDROP_MAP.crates.map((c) => ({ kind: 'planter', x: c.x - CRATE_SIZE / 2, y: c.y - CRATE_SIZE / 2, w: CRATE_SIZE, h: CRATE_SIZE }));

export function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, now: number) {
  const { size } = BACKDROP_MAP;
  const zoom = Math.max(BACKDROP.zoom, w / (size * BACKDROP.fill), h / (size * BACKDROP.fill));
  const viewW = w / zoom, viewH = h / zoom;
  const freeX = size - viewW, freeY = size - viewH;
  const x = freeX / 2 + (freeX / 2) * Math.sin(now / BACKDROP.swayMs);
  const y = freeY / 2 + (freeY / 2) * 0.5 * Math.cos(now / BACKDROP.swayMs);
  const k = dpr * zoom;
  ctx.setTransform(k, 0, 0, k, -x * k, -y * k);
  drawGround(ctx, ground.get(BACKDROP_MAP, size, () => backdropSolids, 'static'), x, y, x + viewW, y + viewH);
  drawGrid(ctx, size, { x, y }, { x: x + viewW, y: y + viewH });
  drawLooseShadows(ctx, backdropCrates);
  drawSolids(ctx, [...backdropSolids, ...backdropCrates]);
}

function drawGrid(ctx: CanvasRenderingContext2D, size: number, tl: Point, br: Point) {
  const x0 = Math.max(0, tl.x), x1 = Math.min(size, br.x), y0 = Math.max(0, tl.y), y1 = Math.min(size, br.y);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.fillStyle = PALETTE.grid;
  for (let x = Math.ceil(x0 / GRID) * GRID; x <= x1; x += GRID) ctx.fillRect(x - 0.5, y0, 1, y1 - y0);
  for (let y = Math.ceil(y0 / GRID) * GRID; y <= y1; y += GRID) ctx.fillRect(x0, y - 0.5, x1 - x0, 1);
}

function drawZone(ctx: CanvasRenderingContext2D, z: ZoneView, index: number) {
  const color = teamColor(z.owner);
  ctx.beginPath();
  ctx.arc(z.x, z.y, z.r, 0, TAU);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([3, 18]);
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(z.x, z.y, z.r - 14, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  const progress = Math.min(1, Math.abs(z.progress));
  if (progress > 0) {
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 8;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = teamColor(z.capturing ?? z.owner);
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.r - 14, -Math.PI / 2, -Math.PI / 2 + progress * TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  ctx.roundRect(z.x - 28, z.y - 28, 56, 56, 12);
  ctx.fillStyle = 'rgba(28, 32, 40, 0.82)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String.fromCharCode(65 + index), z.x, z.y + 2);
}

function drawThrown(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  switch (t.kind) {
    case 'gasCloud': return drawGas(ctx, t, now);
    case 'landMine': {
      ctx.fillStyle = PALETTE.contact;
      ctx.beginPath();
      ctx.arc(t.x + 3, t.y + 4, 14, 0, TAU);
      ctx.fill();
      const body = ctx.createRadialGradient(t.x - 4, t.y - 5, 1, t.x, t.y, 13);
      body.addColorStop(0, '#8a919d');
      body.addColorStop(1, '#2c313b');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 13, 0, TAU);
      ctx.fill();
      const on = Math.floor(now / 400) % 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, on ? 7 : 5, 0, TAU);
      ctx.fillStyle = on ? 'rgba(255, 77, 79, 0.35)' : 'rgba(0, 0, 0, 0)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(t.x, t.y, 4, 0, TAU);
      ctx.fillStyle = on ? '#ff4d4f' : '#7a1f21';
      ctx.fill();
      return;
    }
    case 'grenade':
    case 'fragGrenade':
    case 'gasGrenade': {
      if (t.kind !== 'gasGrenade') drawBlastRing(ctx, t.x, t.y, BLAST_RADIUS[t.kind], now);
      const band = t.kind === 'gasGrenade' ? '#7bb33a' : t.kind === 'fragGrenade' ? '#e07a22' : '#c7c9cc';
      ctx.fillStyle = PALETTE.contact;
      ctx.beginPath();
      ctx.arc(t.x + 5, t.y + 6, 11, 0, TAU);
      ctx.fill();
      if (t.kind === 'fragGrenade') {
        ctx.fillStyle = INK;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + now / 300;
          ctx.fillRect(t.x + Math.cos(a) * 13 - 2, t.y + Math.sin(a) * 13 - 2, 4, 4);
        }
      }
      const body = ctx.createRadialGradient(t.x - 4, t.y - 4, 1, t.x, t.y, 11);
      body.addColorStop(0, '#7d8592');
      body.addColorStop(1, '#262a31');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 11, 0, TAU);
      ctx.fill();
      ctx.fillStyle = band;
      ctx.fillRect(t.x - 10.5, t.y - 2.5, 21, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.arc(t.x - 4, t.y - 4, 2.5, 0, TAU);
      ctx.fill();
      return;
    }
  }
}

const GAS_PUFFS = 7;

function drawGas(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  ctx.fillStyle = PALETTE.gas;
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.r, 0, TAU);
  ctx.fill();
  for (let i = 0; i < GAS_PUFFS; i++) {
    const a = (i / GAS_PUFFS) * TAU + now / 2400 * (i % 2 ? 1 : -1);
    const d = t.r * (0.45 + 0.12 * Math.sin(now / 700 + i));
    ctx.beginPath();
    ctx.arc(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, t.r * 0.42, 0, TAU);
    ctx.fill();
  }
  ctx.setLineDash([10, 10]);
  ctx.lineDashOffset = -now / 60;
  ctx.strokeStyle = PALETTE.gasEdge;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBlastRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 90);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = `rgba(229, 72, 77, ${(0.07 + 0.06 * pulse).toFixed(3)})`;
  ctx.fill();
  ctx.setLineDash([14, 10]);
  ctx.lineDashOffset = -now / 40;
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(229, 72, 77, ${(0.55 + 0.35 * pulse).toFixed(3)})`;
  ctx.stroke();
  ctx.setLineDash([]);
}

const TRAIL_BANDS = 4;
const TRAIL_INK = '#ffffff';

function drawTrails(ctx: CanvasRenderingContext2D, trails: ReadonlyMap<number, readonly TrailPoint[]>, now: number) {
  const dashes = [...trails.values()].flatMap((t) => trailDashes(t, now));
  if (!dashes.length) return;
  ctx.lineCap = 'round';
  ctx.strokeStyle = TRAIL_INK;
  for (const dashing of [false, true]) {
    ctx.lineWidth = dashing ? R * 0.42 : R * 0.19;
    for (let band = 1; band <= TRAIL_BANDS; band++) {
      ctx.globalAlpha = (0.9 * band) / TRAIL_BANDS;
      ctx.beginPath();
      for (const d of dashes) {
        if (d.dashing !== dashing || Math.ceil(d.fade * TRAIL_BANDS) !== band) continue;
        ctx.moveTo(d.x0, d.y0);
        ctx.lineTo(d.x1, d.y1);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

type TracerLook = { r: number; glow: string; color: string; hot: string };

const CLASS_TRACER: TracerLook = { r: 1.6, glow: PALETTE.tracerGlow, color: PALETTE.tracer, hot: PALETTE.tracerHot };

function tracerLook(b: BulletView): TracerLook {
  if (!b.gun || GUNS[b.gun].stage === 0) return CLASS_TRACER;
  const { r, color } = GUNS[b.gun].look.bullet;
  return { r, glow: glow(color, 0.62), color: glow(color, 0.72), hot: glow(color, 0.92) };
}

const TRACER_PASSES = [
  { from: 1, to: 0, width: 5, alpha: 0.16, color: 'glow' },
  { from: 1, to: 0.5, width: 1.5, alpha: 0.45, color: 'color' },
  { from: 0.5, to: 0, width: 2, alpha: 0.95, color: 'color' },
  { from: 0.6, to: 0, width: 1, alpha: 1, color: 'hot' },
] as const;

function drawTracers(ctx: CanvasRenderingContext2D, bullets: readonly BulletView[]) {
  ctx.lineCap = 'round';
  const groups = new Map<string, { look: TracerLook; bullets: BulletView[] }>();
  for (const b of bullets) {
    const look = tracerLook(b);
    const key = `${look.color}|${look.r}`;
    const group = groups.get(key);
    if (group) group.bullets.push(b);
    else groups.set(key, { look, bullets: [b] });
  }
  for (const { look, bullets: group } of groups.values()) {
    for (const { from, to, width, alpha, color } of TRACER_PASSES) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = look[color];
      ctx.lineWidth = look.r * width;
      ctx.beginPath();
      for (const b of group) {
        const far = TRACER.tail * from, near = TRACER.tail * to;
        ctx.moveTo(b.x - b.vx * far, b.y - b.vy * far);
        ctx.lineTo(b.x - b.vx * near, b.y - b.vy * near);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

type PlayerLook = { self: boolean; rival: boolean; flash: number; kick: number; now: number; pxPerUnit: number };
const TIER_COLORS = { 1: '#c9ced8', 2: PALETTE.gold } as const;
const RECOIL = R * 0.22;
const MARK_Y = -R - 8;
const RING = R + 5;

function drawTierMark(ctx: CanvasRenderingContext2D, stage: 1 | 2) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [width, color] of [[4, 'rgba(28, 31, 38, 0.55)'], [2, TIER_COLORS[stage]]] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < stage; i++) {
      const y = MARK_Y - i * 6;
      ctx.moveTo(-6, y);
      ctx.lineTo(0, y - 4.5);
      ctx.lineTo(6, y);
    }
    ctx.stroke();
  }
}

function drawHuntedMark(ctx: CanvasRenderingContext2D, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 220);
  const r = R + 9;
  ctx.globalAlpha *= 0.55 + 0.4 * pulse;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.hunted;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.moveTo(Math.cos(a) * (r - 4), Math.sin(a) * (r - 4));
    ctx.lineTo(Math.cos(a) * (r + 4), Math.sin(a) * (r + 4));
  }
  ctx.stroke();
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerView, color: string, look: PlayerLook) {
  const alpha = p.hidden ? 0.25 : 1;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.globalAlpha = alpha;
  if (look.self || look.rival) {
    ctx.beginPath();
    ctx.arc(0, 0, RING, 0, TAU);
    ctx.lineWidth = 2;
    ctx.strokeStyle = look.self ? color : PALETTE.rival;
    ctx.globalAlpha = alpha * (look.self ? 0.55 : 0.9);
    if (look.rival) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = alpha;
  }
  ctx.rotate(p.angle);
  ctx.translate(-RECOIL * Math.max(0, look.kick), 0);
  drawGun(ctx, p.gun, R);
  ctx.translate(RECOIL * Math.max(0, look.kick), 0);
  ctx.rotate(-p.angle);
  drawBody(ctx, bodySprite(color, R, ARMOR_RIM[p.armorTier], look.pxPerUnit), 0, 0, R);
  if (look.flash > 0) {
    ctx.globalAlpha = look.flash * 0.8 * alpha;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = alpha;
  }
  const { stage } = GUNS[p.gun];
  if (p.hunted && !look.self) drawHuntedMark(ctx, look.now);
  ctx.globalAlpha = alpha;
  if (stage !== 0) drawTierMark(ctx, stage);
  if (p.shield) {
    ctx.beginPath();
    ctx.arc(0, 0, R + 6, p.angle - 1.05, p.angle + 1.05);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.shield;
    ctx.stroke();
  }
  ctx.restore();
}

function drawKillerMark(ctx: CanvasRenderingContext2D, p: PlayerView, now: number, dark: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 200);
  ctx.globalAlpha = 0.65 + 0.35 * pulse;
  ctx.beginPath();
  ctx.arc(p.x, p.y, R + 11, 0, TAU);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = PALETTE.hunted;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = '800 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = dark > 0.5 ? NIGHT.label : PALETTE.hunted;
  ctx.fillText(`KILLER · ${p.name}`, p.x, p.y + MARK_Y - (GUNS[p.gun].stage ? 12 + 6 * GUNS[p.gun].stage : 6));
}

const HURT_SHOW_MS = 1800;
const HURT_FADE_MS = 500;
const TAG = { bar: R + 7, barW: 36, barH: 3.5, name: R + 21, font: 11, nameAlpha: 0.6 } as const;

type Tag = { p: PlayerView; bar: number; name: boolean };
let tagsDrawn: { id: number; bar: boolean; name: boolean }[] = [];
export const drawnTags = () => tagsDrawn;

function bodyTags(bodies: readonly PlayerView[], s: Session, now: number): Tag[] {
  const tags = bodies.filter((p) => p.id === s.myId || !p.hidden).map((p) => {
    if (p.id === s.myId) return { p, bar: p.hp < p.maxHp ? 1 : 0, name: false };
    const hurt = s.hurtAt.get(p.id);
    return { p, bar: hurt === undefined ? 0 : Math.max(0, Math.min(1, (HURT_SHOW_MS - (now - hurt)) / HURT_FADE_MS)), name: true };
  });
  tagsDrawn = tags.map((t) => ({ id: t.p.id, bar: t.bar > 0, name: t.name }));
  return tags;
}

function drawNamesUnderBodies(ctx: CanvasRenderingContext2D, tags: readonly Tag[], dark: number) {
  ctx.font = `600 ${TAG.font}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = dark > 0.5 ? NIGHT.label : PALETTE.label;
  ctx.globalAlpha = TAG.nameAlpha;
  for (const { p, name } of tags) if (name) ctx.fillText(p.name, p.x, p.y + TAG.name);
  ctx.globalAlpha = 1;
}

function drawBars(ctx: CanvasRenderingContext2D, tags: readonly Tag[], dark: number) {
  const ink = dark > 0.5 ? NIGHT.label : PALETTE.label;
  for (const { p, bar } of tags) {
    if (bar <= 0) continue;
    ctx.globalAlpha = bar;
    const x = p.x - TAG.barW / 2, y = p.y + TAG.bar;
    ctx.fillStyle = dark > 0.5 ? 'rgba(230, 235, 245, 0.25)' : 'rgba(40, 44, 52, 0.2)';
    ctx.fillRect(x, y, TAG.barW, TAG.barH);
    const frac = Math.max(0, Math.min(1, p.hp / p.maxHp));
    ctx.fillStyle = frac > 0.35 ? ink : PALETTE.hpBad;
    ctx.fillRect(x, y, TAG.barW * frac, TAG.barH);
  }
  ctx.globalAlpha = 1;
}

function drawDamageNumbers(ctx: CanvasRenderingContext2D, numbers: readonly DamageNumber[], now: number) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const n of numbers) {
    const k = (now - n.born) / NUMBER_MS;
    if (k < 0 || k >= 1) continue;
    const player = n.kind === 'player';
    ctx.globalAlpha = 1 - k * k;
    ctx.font = `800 ${player ? 17 : 13}px system-ui, sans-serif`;
    const label = String(Math.max(1, Math.round(n.amount)));
    const y = n.y + MARK_Y - 10 - numberHeight(n, now);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(28, 31, 38, 0.75)';
    ctx.strokeText(label, n.x, y);
    ctx.fillStyle = player ? PALETTE.gold : '#fff3dc';
    ctx.fillText(label, n.x, y);
  }
  ctx.globalAlpha = 1;
}
