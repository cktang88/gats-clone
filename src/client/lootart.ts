import { LOOT, TOWER, type LootTier } from '../shared/defs.ts';
import type { CacheView, Snapshot, TowerView } from '../shared/protocol.ts';
import { setLight } from './lighting.ts';
import { INK, shade, tint } from './palette.ts';
import { LIGHT } from './tilt.ts';

/**
 * Last Standing's loot and recon, in the toy-soldier kit (docs/art/STYLE.md): bold ink outlines, two hard cel steps, a hanging front face.
 * - Loot caches: a chunky wooden footlocker whose lid, corner straps and the soft pool of light on the floor round it take the tier's colour
 *   (Common bone, Rare blue, Epic purple). An epic one breathes, throws a faint shaft of light and twinkles with a few sparkles, so it pulls the
 *   eye from across the screen. Opened, it stays where it was looted: its lid thrown back, the hold empty, and the whole box dimmed.
 * - Recon towers: a lattice mast with a dish on top over a concrete pad, its capture circle dashed on the floor. While someone takes it a
 *   progress arc runs round the circle; resting, it is dim and counts down to ready. Taking one sends a sonar sweep racing out from the mast.
 */

const TAU = Math.PI * 2;
type View = { x0: number; y0: number; x1: number; y1: number };
const visible = (v: View, x: number, y: number, pad: number) => x > v.x0 - pad && x < v.x1 + pad && y > v.y0 - pad && y < v.y1 + pad;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Each tier's look: `lid` its paint, `glow` the light it throws, `pool` how far (in box sizes) and how bright the floor glow reaches. */
export const LOOT_LOOK: Record<LootTier, { name: string; lid: string; glow: string; pool: number; poolAlpha: number }> = {
  0: { name: 'Common', lid: '#cfc8b4', glow: '#ece6d6', pool: 1.25, poolAlpha: 0.16 },
  1: { name: 'Rare', lid: '#5aa9ff', glow: '#5aa9ff', pool: 1.7, poolAlpha: 0.3 },
  2: { name: 'Epic', lid: '#b06bff', glow: '#b06bff', pool: 2.2, poolAlpha: 0.36 },
};
const WOOD = '#8a5d36', WOOD_FACE = '#6a4527', WOOD_DARK = '#4a2f1a';
const HOLD = '#231a14';
const RECON = '#7fd4ff', STEEL = '#8b939d', STEEL_DARK = '#5d646d', CONCRETE = '#a7a49b', BONE = '#ece6d6', SIGNAL = '#ff5a1f';

const rgba = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
};
/** A slow breath for an epic cache, offset per cache so a field of them does not pulse in step. */
const breath = (now: number, id: number) => (REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420 + id * 1.7));

// ---------------------------------------------------------------------------------------------------------------- caches

/** The soft tier-coloured pool of light on the floor under every unopened cache; drawn under every body. */
export function drawCacheFloor(ctx: CanvasRenderingContext2D, caches: readonly CacheView[], now: number, view: View) {
  for (const [id, x, y, tier, opened] of caches) {
    if (opened || !visible(view, x, y, LOOT.size * 3)) continue;
    const look = LOOT_LOOK[tier];
    const b = tier === 2 ? breath(now, id) : 0.5;
    const r = LOOT.size * look.pool * (tier === 2 ? 0.92 + 0.16 * b : 1);
    const a = look.poolAlpha * (tier === 2 ? 0.75 + 0.5 * b : 1);
    const g = ctx.createRadialGradient(x, y + 4, 0, x, y + 4, r);
    g.addColorStop(0, rgba(look.glow, a));
    g.addColorStop(0.55, rgba(look.glow, a * 0.45));
    g.addColorStop(1, rgba(look.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y + 4, r, r * 0.8, 0, 0, TAU);
    ctx.fill();
    if (tier > 0) setLight(`cache:${id}`, { x, y, radius: LOOT.size * (tier === 2 ? 4 : 2.6), color: look.glow, intensity: tier === 2 ? 0.55 + 0.25 * b : 0.4, size: 12 });
  }
}

/** A four-point glint, `r` long, centred on (x, y). */
function glint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const w = r * 0.24;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + w, y - w); ctx.lineTo(x + r, y); ctx.lineTo(x + w, y + w);
  ctx.lineTo(x, y + r); ctx.lineTo(x - w, y + w); ctx.lineTo(x - r, y); ctx.lineTo(x - w, y - w);
  ctx.closePath();
  ctx.fill();
}

/**
 * One cache at (x, y), `LOOT.size` across: a contact shadow, the box's front face hanging below its top, and either the closed lid in the
 * tier's paint with its straps and latch, or (opened) the lid thrown back over an empty hold.
 */
export function drawCache(ctx: CanvasRenderingContext2D, x: number, y: number, tier: LootTier, opened: boolean, now = 0, id = 0) {
  const look = LOOT_LOOK[tier];
  const S = LOOT.size, h = S / 2, d = S * 0.78 / 2, face = 10;
  const lid = look.lid;
  ctx.save();
  ctx.lineJoin = 'round';
  if (opened) ctx.globalAlpha *= 0.62;
  // Contact shadow, thrown along the light.
  ctx.fillStyle = 'rgba(10, 12, 18, 0.38)';
  ctx.beginPath();
  ctx.ellipse(x + LIGHT.x * 5, y + d + face * 0.6 + LIGHT.y * 3, h + 4, 6, 0, 0, TAU);
  ctx.fill();
  // The front face: planks, the tier's corner straps.
  const top = y - d, front = y + d;
  ctx.fillStyle = opened ? shade(WOOD_FACE, 0.8) : WOOD_FACE;
  ctx.fillRect(x - h, front, S, face);
  ctx.fillStyle = 'rgba(10, 12, 16, 0.28)';
  ctx.fillRect(x + h * 0.35, front, h * 0.65, face);
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(x - h, front + face / 2 - 0.6, S, 1.2);
  ctx.fillStyle = opened ? shade(lid, 0.55) : shade(lid, 0.8);
  ctx.fillRect(x - h, front, 5, face);
  ctx.fillRect(x + h - 5, front, 5, face);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.strokeRect(x - h, front, S, face);
  if (!opened) {
    // A rare or epic one is rimmed in its own light, so it reads from across the screen.
    if (tier > 0) {
      ctx.strokeStyle = rgba(look.glow, tier === 2 ? 0.35 + 0.35 * breath(now, id) : 0.4);
      ctx.lineWidth = 7;
      ctx.strokeRect(x - h - 1, top - 1, S + 2, d * 2 + face + 2);
    }
    // The closed lid: tier paint with the kit's two cel steps, a lip overhanging the box, steel corner caps and a brass latch.
    ctx.fillStyle = shade(lid, 0.74);
    ctx.fillRect(x - h - 1.5, top - 1.5, S + 3, d * 2 + 3);
    ctx.fillStyle = lid;
    ctx.fillRect(x - h - 1.5, top - 1.5, S - 3, d * 2 - 2);
    ctx.fillStyle = tint(lid, 0.4);
    ctx.fillRect(x - h - 1.5, top - 1.5, S * 0.6, 3);
    ctx.fillRect(x - h - 1.5, top - 1.5, 3, d * 1.2);
    // A raised seam down the lid's middle, where it would open.
    ctx.fillStyle = shade(lid, 0.6);
    ctx.fillRect(x - h + 2, top + d - 1, S - 4, 2.4);
    ctx.fillStyle = '#3a3f47';
    for (const [cx, cy] of [[x - h - 1.5, top - 1.5], [x + h - 4.5, top - 1.5], [x - h - 1.5, top + d * 2 - 1.5], [x + h - 4.5, top + d * 2 - 1.5]] as const) ctx.fillRect(cx, cy, 6, 3);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x - h - 1.5, top - 1.5, S + 3, d * 2 + 3);
    ctx.fillStyle = '#e7b84a';
    ctx.fillRect(x - 3.5, front - 2, 7, 8);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(x - 3.5, front - 2, 7, 8);
    if (tier === 2) {
      // A stencilled star on the lid of an epic one.
      ctx.fillStyle = tint(lid, 0.75);
      glint(ctx, x, top + d - 4.5, 5);
    } else if (tier === 1) {
      ctx.fillStyle = tint(lid, 0.6);
      ctx.beginPath();
      ctx.moveTo(x, top + d - 8); ctx.lineTo(x + 4, top + d - 4); ctx.lineTo(x, top + d - 0.5); ctx.lineTo(x - 4, top + d - 4);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // The empty hold, the inside of the near wall lit, and the lid thrown back, leaning away past the far edge.
    ctx.fillStyle = shade(WOOD, 0.9);
    ctx.fillRect(x - h, top, S, d * 2);
    ctx.fillStyle = HOLD;
    ctx.fillRect(x - h + 3.5, top + 3, S - 7, d * 2 - 6);
    ctx.fillStyle = shade(WOOD, 0.7);
    ctx.fillRect(x - h + 3.5, top + d * 2 - 7, S - 7, 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x - h, top, S, d * 2);
    const lidH = 8, lean = 3;
    ctx.fillStyle = shade(lid, 0.62);
    ctx.beginPath();
    ctx.moveTo(x - h - 1, top); ctx.lineTo(x + h + 1, top); ctx.lineTo(x + h + 1 - lean, top - lidH); ctx.lineTo(x - h - 1 + lean, top - lidH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = shade(lid, 0.85);
    ctx.fillRect(x - h + lean, top - lidH + 1, S - lean * 2, 2.4);
  }
  ctx.restore();
  if (!opened && tier === 2 && !REDUCED) drawSparkles(ctx, x, y, id, now);
}

/** A few sparkles twinkling up off an epic cache, each on its own clock. */
function drawSparkles(ctx: CanvasRenderingContext2D, x: number, y: number, id: number, now: number) {
  ctx.save();
  ctx.fillStyle = '#f6ecff';
  ctx.strokeStyle = rgba(LOOT_LOOK[2].glow, 0.9);
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 5; i++) {
    const period = 1300 + i * 170;
    const u = ((now + id * 389 + i * 331) % period) / period;
    const a = (id * 2.3 + i * 1.9) % TAU;
    const sx = x + Math.cos(a) * (LOOT.size * 0.7), sy = y - 6 + Math.sin(a) * (LOOT.size * 0.45) - u * 20;
    ctx.globalAlpha = Math.sin(u * Math.PI);
    glint(ctx, sx, sy, 3 + 4.5 * Math.sin(u * Math.PI));
    ctx.stroke();
  }
  ctx.restore();
}

/** Every cache in view, unopened ones and the looted ones left behind. An epic one also throws a faint shaft of its light up the screen. */
export function drawCaches(ctx: CanvasRenderingContext2D, caches: readonly CacheView[], now: number, view: View) {
  for (const [id, x, y, tier, opened] of caches) {
    if (!visible(view, x, y, LOOT.size * 2)) continue;
    if (tier === 2 && !opened) {
      const b = breath(now, id), top = y - 150;
      const g = ctx.createLinearGradient(0, y, 0, top);
      g.addColorStop(0, rgba(LOOT_LOOK[2].glow, 0.22 + 0.12 * b));
      g.addColorStop(1, rgba(LOOT_LOOK[2].glow, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - LOOT.size * 0.45, y);
      ctx.lineTo(x - LOOT.size * 0.25, top);
      ctx.lineTo(x + LOOT.size * 0.25, top);
      ctx.lineTo(x + LOOT.size * 0.45, y);
      ctx.closePath();
      ctx.fill();
    }
    drawCache(ctx, x, y, tier, !!opened, now, id);
  }
}

/** The minimap: unopened Rare and Epic caches as tiny squares of their colour (Commons and opened ones are left off, to keep it clear). */
export function drawCachesMap(ctx: CanvasRenderingContext2D, caches: readonly CacheView[] | undefined, x: number, y: number, k: number) {
  for (const [, cx, cy, tier, opened] of caches ?? []) {
    if (opened || tier === 0) continue;
    const s = tier === 2 ? 4 : 3;
    ctx.fillStyle = INK;
    ctx.fillRect(x + cx * k - s / 2 - 1, y + cy * k - s / 2 - 1, s + 2, s + 2);
    ctx.fillStyle = LOOT_LOOK[tier].lid;
    ctx.fillRect(x + cx * k - s / 2, y + cy * k - s / 2, s, s);
  }
}

// ---------------------------------------------------------------------------------------------------------------- towers

const MAST = { h: 112, base: 18, top: 5, dish: 21 } as const;
const towerReady = (t: TowerView) => !t.readyAt;

/** A tower's capture circle on the floor (dashed recon blue when ready, grey when resting) and the mast's long shadow; drawn under every body. */
export function drawTowerFloor(ctx: CanvasRenderingContext2D, towers: readonly TowerView[], now: number, view: View) {
  for (const t of towers) {
    if (!visible(view, t.x, t.y, TOWER.radius + MAST.h)) continue;
    const ready = towerReady(t), taking = t.progress !== undefined;
    ctx.save();
    ctx.fillStyle = ready ? rgba(RECON, taking ? 0.16 : 0.08) : 'rgba(120, 124, 132, 0.08)';
    ctx.beginPath();
    ctx.arc(t.x, t.y, TOWER.radius, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    if (ready && !REDUCED) ctx.lineDashOffset = -now / 60;
    ctx.strokeStyle = ready ? rgba(RECON, 0.75) : 'rgba(150, 154, 162, 0.5)';
    ctx.stroke();
    ctx.setLineDash([]);
    // The mast's shadow, thrown along the light across the floor.
    const sx = LIGHT.x * MAST.h * 0.55, sy = LIGHT.y * MAST.h * 0.55;
    ctx.fillStyle = 'rgba(10, 12, 18, 0.22)';
    ctx.beginPath();
    ctx.moveTo(t.x - MAST.base * 0.7, t.y);
    ctx.lineTo(t.x + MAST.base * 0.7, t.y);
    ctx.lineTo(t.x + sx + 4, t.y + sy);
    ctx.lineTo(t.x + sx - 4, t.y + sy);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(t.x + sx, t.y + sy, MAST.dish * 0.6, MAST.dish * 0.3, 0.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * The mast itself at (x, y), `ready` or resting, with `spin` turning the dish: a concrete pad, two splayed steel legs braced in a zigzag
 * up to a cap, the dish on top facing out and a lamp on its feed. `taking` blinks the lamp fast in signal orange.
 */
export function drawTower(ctx: CanvasRenderingContext2D, x: number, y: number, ready: boolean, taking: boolean, now: number) {
  const { h, base, top, dish } = MAST;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!ready) ctx.globalAlpha *= 0.72;
  // The pad.
  ctx.fillStyle = shade(CONCRETE, 0.72);
  ctx.fillRect(x - base - 5, y + 2, base * 2 + 10, 7);
  ctx.fillStyle = CONCRETE;
  ctx.fillRect(x - base - 5, y - 9, base * 2 + 10, 11);
  ctx.fillStyle = tint(CONCRETE, 0.3);
  ctx.fillRect(x - base - 5, y - 9, base * 2 + 10, 3);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - base - 5, y - 9, base * 2 + 10, 18);
  // The legs and their bracing, inked then painted.
  const ty = y - h;
  const legs = () => {
    ctx.beginPath();
    ctx.moveTo(x - base, y - 3); ctx.lineTo(x - top, ty);
    ctx.moveTo(x + base, y - 3); ctx.lineTo(x + top, ty);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const f0 = i / n, f1 = (i + 1) / n;
      const lx = (f: number) => x - base + (base - top) * f, rx = (f: number) => x + base - (base - top) * f, yy = (f: number) => y - 3 - (h - 3) * f;
      if (i % 2) { ctx.moveTo(lx(f0), yy(f0)); ctx.lineTo(rx(f1), yy(f1)); } else { ctx.moveTo(rx(f0), yy(f0)); ctx.lineTo(lx(f1), yy(f1)); }
      ctx.moveTo(lx(f1), yy(f1)); ctx.lineTo(rx(f1), yy(f1));
    }
  };
  legs();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5.5;
  ctx.stroke();
  ctx.strokeStyle = ready ? STEEL : STEEL_DARK;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  // A ladder of light on the left legs (the lit side).
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - base + 1, y - 4); ctx.lineTo(x - top + 1, ty + 1);
  ctx.stroke();
  // The cap the dish turns on.
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(x - 8, ty - 6, 16, 8);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 8, ty - 6, 16, 8);
  // The dish: a bowl seen side-on, tipped to the sky and slowly panning, its hollow in shade and a feed arm out of its middle.
  const pan = ready && !REDUCED ? Math.sin(now / 1700) : 0.35;
  const tilt = -0.32 * pan;
  const dy = ty - 12, wide = dish * (0.8 + 0.2 * Math.abs(pan));
  ctx.save();
  ctx.translate(x, dy);
  ctx.rotate(tilt);
  ctx.fillStyle = ready ? shade(BONE, 0.78) : shade(BONE, 0.55);
  ctx.beginPath();
  ctx.ellipse(0, 0, wide, dish * 0.5, 0, 0, Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = ready ? BONE : shade(BONE, 0.7);
  ctx.beginPath();
  ctx.ellipse(0, 0, wide, dish * 0.24, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(10, 12, 16, 0.18)';
  ctx.beginPath();
  ctx.ellipse(wide * 0.15, 0.5, wide * 0.7, dish * 0.15, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, wide, dish * 0.5, 0, 0, Math.PI);
  ctx.closePath();
  ctx.moveTo(wide, 0);
  ctx.ellipse(0, 0, wide, dish * 0.24, 0, 0, TAU);
  ctx.stroke();
  // The feed: an arm up out of the bowl to the lamp.
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, -14);
  ctx.stroke();
  const local = { x: 0, y: -15 };
  ctx.restore();
  const fx = x + Math.cos(tilt) * local.x - Math.sin(tilt) * local.y, fy = dy + Math.sin(tilt) * local.x + Math.cos(tilt) * local.y;
  ctx.strokeStyle = INK;
  const blink = taking ? Math.floor(now / 140) % 2 === 0 : ready ? Math.sin(now / 380) > 0.2 : false;
  ctx.fillStyle = taking ? (blink ? SIGNAL : shade(SIGNAL, 0.5)) : ready ? (blink ? RECON : shade(RECON, 0.55)) : '#555b63';
  ctx.beginPath();
  ctx.arc(fx, fy, 3.6, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // The pole's whip antenna.
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x + 5, ty - 4); ctx.lineTo(x + 7, ty - 40);
  ctx.stroke();
  ctx.restore();
  if (ready && blink) setLight(`tower:${x}:${y}`, { x: fx, y: fy, radius: 60, color: taking ? SIGNAL : RECON, intensity: 0.5, size: 6 });
}

/** Every tower in view: drawn with the props' tops, since the mast stands over the soldiers at its foot. */
export function drawTowers(ctx: CanvasRenderingContext2D, towers: readonly TowerView[], now: number, view: View) {
  for (const t of towers) {
    if (!visible(view, t.x, t.y - MAST.h / 2, MAST.h)) continue;
    drawTower(ctx, t.x, t.y, towerReady(t), t.progress !== undefined, now);
  }
}

/** True when a tower needs the server clock this frame: one resting shows its countdown. */
export const towersNeedClock = (towers: readonly TowerView[] | undefined) => !!towers?.some((t) => t.readyAt > 0);

/**
 * Over the night shade, so they read in the dark: the progress arc round a tower's circle while someone takes it, and the seconds until a
 * resting tower is ready again on a plate above its dish (`serverNow` null when that cannot be known; then the plate is left off).
 */
/**
 * A cache being opened (`CacheView`'s `opening`, 0..1): a ring of its tier's colour fills round it over `LOOT.openMs`, with the seconds
 * left on a plate above, so the one opening it and anyone watching can see how long they have. Drawn over the night shade.
 */
export function drawCacheOverlay(ctx: CanvasRenderingContext2D, caches: readonly CacheView[], view: View) {
  for (const [, x, y, tier, opened, opening] of caches) {
    if (opened || opening === undefined || !visible(view, x, y, LOOT.size * 3)) continue;
    const p = Math.max(0, Math.min(1, opening)), r = LOOT.size * 1.25;
    const color = LOOT_LOOK[tier].glow;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(10, 12, 18, 0.55)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + p * TAU);
    ctx.stroke();
    ctx.restore();
    plate(ctx, `OPENING ${Math.max(1, Math.ceil(((1 - p) * LOOT.openMs) / 1000))}s`, x, y - r - 20, color);
  }
}

export function drawTowerOverlay(ctx: CanvasRenderingContext2D, towers: readonly TowerView[], serverNow: number | null, now: number, view: View) {
  for (const t of towers) {
    if (!visible(view, t.x, t.y, TOWER.radius + MAST.h)) continue;
    if (t.progress !== undefined) {
      const p = Math.max(0, Math.min(1, t.progress));
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(10, 12, 18, 0.5)';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(t.x, t.y, TOWER.radius, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = RECON;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(t.x, t.y, TOWER.radius, -Math.PI / 2, -Math.PI / 2 + p * TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    if (t.readyAt > 0 && serverNow !== null) {
      const secs = Math.max(0, Math.ceil((t.readyAt - serverNow) / 1000));
      plate(ctx, `${secs}s`, t.x, t.y - MAST.h - 48, '#c3c8d0');
    } else if (t.readyAt === 0 && t.progress === undefined) {
      plate(ctx, 'RECON', t.x, t.y - MAST.h - 48, RECON, 0.55 + 0.25 * Math.sin(now / 500));
    }
  }
}

const FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';
function plate(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `800 17px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 14, hh = 22;
  ctx.fillStyle = 'rgba(19, 21, 25, 0.86)';
  ctx.fillRect(x - w / 2, y - hh / 2, w, hh);
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y + hh / 2 - 2, w, 2);
  ctx.fillText(label, x, y + 1);
  ctx.restore();
}

/** The minimap: each tower as a little antenna, bright recon blue when ready and grey while it rests. */
export function drawTowersMap(ctx: CanvasRenderingContext2D, towers: readonly TowerView[] | undefined, x: number, y: number, k: number, now: number) {
  for (const t of towers ?? []) {
    const mx = x + t.x * k, my = y + t.y * k, ready = towerReady(t);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const draw = () => {
      ctx.beginPath();
      ctx.moveTo(mx - 3.5, my + 4); ctx.lineTo(mx, my - 3); ctx.lineTo(mx + 3.5, my + 4);
      ctx.moveTo(mx, my - 3); ctx.lineTo(mx, my + 4);
      ctx.moveTo(mx - 3.5, my - 5.5); ctx.quadraticCurveTo(mx, my - 2, mx + 3.5, my - 5.5);
    };
    draw();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = ready ? RECON : '#6b7079';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    if (t.progress !== undefined) {
      ctx.strokeStyle = SIGNAL;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx, my, 7 + Math.sin(now / 150), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------------------------- the recon sweep

const SWEEP_MS = 1600;
type Sweep = { x: number; y: number; r: number; born: number };
const sweeps: Sweep[] = [];
const seenSweeps = new Set<string>();

/** One recon sweep per `tower` event: a bright ring racing out to the tower's reach with a fainter one behind and a wash inside. */
export function drawTowerFx(ctx: CanvasRenderingContext2D, snap: Pick<Snapshot, 'events' | 'tick'>, now: number) {
  for (const ev of snap.events) {
    if (ev.e !== 'tower') continue;
    const key = `${snap.tick}:${Math.round(ev.x)}:${Math.round(ev.y)}`;
    if (seenSweeps.has(key)) continue;
    seenSweeps.add(key);
    if (seenSweeps.size > 32) seenSweeps.delete(seenSweeps.values().next().value!);
    sweeps.push({ x: ev.x, y: ev.y, r: ev.r, born: now });
  }
  while (sweeps.length && now - sweeps[0]!.born > SWEEP_MS) sweeps.shift();
  for (const s of sweeps) {
    const k = (now - s.born) / SWEEP_MS;
    if (k < 0 || k >= 1) continue;
    const fade = 1 - k;
    ctx.save();
    for (const [lag, w, a] of [[0, 5 + 8 * fade, 0.85], [0.12, 2.5, 0.45]] as const) {
      const kk = Math.max(0, k - lag);
      const r = s.r * (1 - (1 - kk) ** 2);
      ctx.strokeStyle = rgba(RECON, a * fade);
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(RECON, 0.07 * fade);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (1 - (1 - k) ** 2), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
