import { COSMETIC_BY_ID, type Cosmetic } from '../shared/cosmetics.ts';
import { COLORS, WORLD, type ColorId, type GunId } from '../shared/defs.ts';
import { drawSoldier } from './bodies.ts';
import { drawBursts, emitBit, resetFx, onDeath } from './killfx.ts';
import { drawGunArt, drawHeldGun, heldHands } from './gunart.ts';
import { cosLook, lookOfEquipped, type CosLook } from './cosmeticlook.ts';
import type { Equipped } from '../shared/cosmetics.ts';
import { nameInk } from './nametag.ts';
import { recordBounds, unionBounds, type Bounds } from './drawbounds.ts';

/**
 * Soldiers and items drawn into plain canvases for the menu: the armory's live preview, the grid's icons, the XP card's reveal and
 * the profile page. They use the same drawing as the match (drawSoldier, the gun art), so what you pick is what others see.
 */
const R = WORLD.playerRadius;
const dprOf = () => Math.max(1, Math.min(3, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));

export type PreviewOpts = {
  look: CosLook; color: string; gun: GunId; aim: number; now: number;
  /** Body radii on screen; the soldier is drawn at `scale` x the world's size. */
  scale: number;
  armor?: 'none' | 'light' | 'medium' | 'heavy';
  walking?: boolean;
  /** Where the soldier stands, as shares of the canvas (default centre). */
  at?: { x: number; y: number };
  /** No gun: the hands rest together in front of the chest, so a card's soldier is all helmet and torso. */
  unarmed?: boolean;
};

/** Where an unarmed soldier's hands rest, in its own frame (forward, across), in body radii. */
const REST_HANDS = [{ x: 0.5, y: 0.3 }, { x: 0.5, y: -0.3 }] as const;

function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(canvas.clientWidth || rect.width || Number(canvas.dataset.w) || 160);
  const h = Math.round(canvas.clientHeight || rect.height || Number(canvas.dataset.h) || 120);
  const dpr = dprOf();
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

/** The soldier at the origin, `pxPerUnit` device px to a world unit (its sprites are painted that sharp). */
function paintSoldier(ctx: CanvasRenderingContext2D, o: Omit<PreviewOpts, 'scale' | 'at'>, pxPerUnit: number): void {
  const hands = o.unarmed ? REST_HANDS.map((p) => ({ x: p.x * R, y: p.y * R })) as [{ x: number; y: number }, { x: number; y: number }] : heldHands(o.gun, R, o.aim);
  const phase = o.walking ? o.now / 260 : 0;
  drawSoldier(ctx, o.color, 0, 0, R, {
    angle: o.aim, armor: o.armor ?? 'medium', hands, jump: 0, flash: 0,
    helmet: o.look.helmet, camo: o.look.camo, spin: o.now / 180,
    gait: o.walking ? { x: 0, y: 0, t: o.now, phase, speed: 220, heading: o.aim } : undefined,
    gun: o.unarmed ? undefined : (g) => drawHeldGun(g, o.gun, R, o.aim, false, o.look.skin),
  }, pxPerUnit);
}

/** A soldier with a gun, standing on a contact shadow, in the canvas. */
export function drawPreview(canvas: HTMLCanvasElement, o: PreviewOpts): void {
  const f = fit(canvas);
  if (!f) return;
  const { ctx, w, h, dpr } = f;
  const x = w * (o.at?.x ?? 0.5), y = h * (o.at?.y ?? 0.52);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(o.scale, o.scale);
  paintSoldier(ctx, o, dpr * o.scale);
  ctx.restore();
}

/** Room left clear round a card's art, in CSS px, so nothing touches the canvas edge (the reveal's glow and rays show past it). */
export const ART_PAD = 6;
/** How sharp the sprites are when a soldier is only measured: about one pixel to a world unit, enough to find its ink. */
const MEASURE_PX = 1;
const inkOf = new Map<string, Bounds | null>();

/**
 * Where a soldier puts ink, in world units round its centre, over every frame of anything that turns on it (a propeller's
 * spin), so the art fitted to it never clips. Measured once per look.
 */
export function soldierInk(o: Omit<PreviewOpts, 'scale' | 'at' | 'now'>): Bounds | null {
  const key = `${o.look.helmet}|${o.look.camo}|${o.look.skin}|${o.color}|${o.gun}|${o.aim}|${o.armor ?? 'medium'}|${!!o.unarmed}`;
  if (inkOf.has(key)) return inkOf.get(key)!;
  let ink: Bounds | null = null;
  // The look minus its camo (which never changes the outline), at eight turns of the propeller.
  const plain = { ...o, look: { ...o.look, camo: 'c_plain' } };
  for (let i = 0; i < 8; i++) {
    const rec = recordBounds();
    paintSoldier(rec.ctx, { ...plain, now: (i / 8) * Math.PI * 2 * 180 }, MEASURE_PX);
    ink = unionBounds(ink, rec.bounds());
  }
  inkOf.set(key, ink);
  return ink;
}

/** The scale and place that fit `ink` (world units round the soldier) centred in a `w` x `h` canvas, `pad` px clear of each edge. */
export function fitInk(ink: Bounds, w: number, h: number, pad = ART_PAD): { scale: number; at: { x: number; y: number } } {
  const scale = Math.max(0.05, Math.min((w - 2 * pad) / Math.max(1, ink.x1 - ink.x0), (h - 2 * pad) / Math.max(1, ink.y1 - ink.y0)));
  return { scale, at: { x: (w / 2 - ((ink.x0 + ink.x1) / 2) * scale) / w, y: (h / 2 - ((ink.y0 + ink.y1) / 2) * scale) / h } };
}

/** A helmet or camo card: the whole soldier, unarmed and turned toward the viewer, as big as the card allows with room round it. */
export function drawBust(canvas: HTMLCanvasElement, c: Cosmetic, color: ColorId = 'blue', now = 0): void {
  const f = fit(canvas);
  if (!f) return;
  const look = lookOfEquipped({ [c.slot]: c.id } as unknown as Equipped);
  const o = { look, color: COLORS[color], gun: 'smg' as GunId, aim: Math.PI * 0.5, armor: c.slot === 'camo' ? 'none' as const : 'light' as const, unarmed: true };
  const ink = soldierInk(o);
  const place = ink ? fitInk(ink, f.w, f.h) : { scale: Math.min(f.w / 56, f.h / 62), at: { x: 0.5, y: 0.5 } };
  drawPreview(canvas, { ...o, now, ...place });
}

/** A gun in a skin, for a skin card. */
export function drawSkinCard(canvas: HTMLCanvasElement, c: Cosmetic, gun: GunId = 'assault'): void {
  const f = fit(canvas);
  if (!f) return;
  drawGunArt(f.ctx, gun, ART_PAD, ART_PAD, f.w - 2 * ART_PAD, f.h - 2 * ART_PAD, { skin: c.id });
}

/** Name colour and title cards: the item itself as it would read on a plate. */
export function drawNameSample(canvas: HTMLCanvasElement, c: Cosmetic, name: string, now = 0): void {
  const f = fit(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  ctx.fillStyle = '#131519';
  ctx.beginPath();
  const pw = Math.min(w - 2 * ART_PAD, 150), ph = Math.min(24, h - 2 * ART_PAD), px = (w - pw) / 2, py = (h - ph) / 2, cut = 5;
  ctx.moveTo(px, py); ctx.lineTo(px + pw - cut, py); ctx.lineTo(px + pw, py + cut); ctx.lineTo(px + pw, py + ph); ctx.lineTo(px + cut, py + ph); ctx.lineTo(px, py + ph - cut);
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A long title steps its type down until it sits inside the plate.
  let size = 17, tw = 0;
  for (; ; size -= 1) {
    ctx.font = `700 ${size}px "Barlow Condensed", system-ui, sans-serif`;
    tw = ctx.measureText(name).width;
    if (tw <= pw - 10 || size <= 12) break;
  }
  if (c.slot === 'nameColor') ctx.fillStyle = nameInk(ctx, c.id, w / 2 - tw / 2, tw, now);
  else ctx.fillStyle = '#ece6d6';
  ctx.fillText(name, w / 2, h / 2 + 1, pw - 10);
}

/** A kill effect card: its swatch colours as a small burst, drawn flat (the live effect plays in the armory's preview). */
export function drawFxSample(canvas: HTMLCanvasElement, c: Cosmetic): void {
  const f = fit(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  const cols = c.swatch.length ? c.swatch : ['#e2dccb'];
  ctx.lineJoin = 'round';
  const round = c.id === 'k_ink' || c.id === 'k_bubbles';
  const bits = Array.from({ length: 9 }, (_, i) => {
    const a = (i * Math.PI * 2) / 9 + 0.3, r = 12 + (i % 3) * 7;
    return { x: Math.cos(a) * r * 1.5, y: Math.sin(a) * r * 0.9, hx: round ? 4 + (i % 3) * 2 : 4, hy: round ? 4 + (i % 3) * 2 : 3 };
  });
  // Scaled so the burst, outlines and all, spans the card inside its padding.
  const ex = Math.max(...bits.map((p) => Math.abs(p.x) + p.hx)) + 0.8, ey = Math.max(...bits.map((p) => Math.abs(p.y) + p.hy)) + 0.8;
  const k = Math.min((w / 2 - ART_PAD) / ex, (h / 2 - ART_PAD) / ey);
  ctx.translate(w / 2, h / 2);
  ctx.scale(k, k);
  bits.forEach((p, i) => {
    ctx.fillStyle = cols[i % cols.length]!;
    ctx.strokeStyle = '#1c1f26';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (round) ctx.arc(p.x, p.y, p.hx, 0, Math.PI * 2);
    else ctx.rect(p.x - p.hx, p.y - p.hy, p.hx * 2, p.hy * 2);
    ctx.fill();
    ctx.stroke();
  });
}

/** The card art for any cosmetic. */
export function drawItem(canvas: HTMLCanvasElement, c: Cosmetic, now = 0): void {
  switch (c.slot) {
    case 'helmet': case 'camo': return drawBust(canvas, c, 'blue', now);
    case 'gunSkin': return drawSkinCard(canvas, c);
    case 'nameColor': return drawNameSample(canvas, c, 'Viper', now);
    case 'title': return drawNameSample(canvas, c, c.name, now);
    case 'killFx': return drawFxSample(canvas, c);
  }
}

/** Plays kill effect `fx` on a preview canvas: call every frame with the page clock; it re-fires the burst every `every` ms. */
export function createFxStage() {
  let last = -Infinity;
  return (canvas: HTMLCanvasElement, fx: string, now: number, every = 1500) => {
    const f = fit(canvas);
    if (!f) return;
    if (now - last > every) {
      last = now;
      resetFx();
      onDeath({ x: 0, y: 0, color: '#3a7be8', dir: 0.4, mine: false, self: false, preview: true, fx }, now);
    }
    f.ctx.save();
    f.ctx.translate(f.w / 2, f.h * 0.55);
    drawBursts(f.ctx, now);
    f.ctx.restore();
  };
}
void emitBit; void cosLook; void COSMETIC_BY_ID;
