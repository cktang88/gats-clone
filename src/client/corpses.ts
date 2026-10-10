import { GUNS, WORLD, ZOMBIES, type GunId, type ZombieKind } from '../shared/defs.ts';
import { INK } from './palette.ts';
import { drawDroppedGun } from './gunart.ts';
import { drawFallenSoldier } from './bodies.ts';
import type { Cos } from '../shared/cosmetics.ts';
import { cosLook } from './cosmeticlook.ts';
import { drawZombieRemains } from './zombieart.ts';
import { newSpriteFrame } from './zombiekit.ts';

/**
 * A fallen player left where they died, on the map they died on, drawn as plainly dead until it fades.
 * `blow` is the direction the killing hit travelled, null when nobody's position was known; `blast` marks an explosive death.
 */
export type Corpse = {
  victim: number; x: number; y: number; angle: number; color: string; gun: GunId; map: string; born: number;
  blow: number | null; blast: boolean;
  /** What the fallen wore (helmet, camo, gun skin), so the dead keep their look and their gun's finish. */
  cos?: Cos;
};

/**
 * How long a corpse lies, the fade at the end of that, the most kept at once, the pool's spread over its first `poolMs`,
 * how long the body takes to settle and the dropped gun to slide to rest, and how far a hit knocks the body.
 */
export const CORPSE = { lifeMs: 30_000, fadeMs: 3_000, cap: 60, poolMs: 1_400, dropMs: 220, slideMs: 380, knockPx: 10 } as const;

const R = WORLD.playerRadius;
const DEAD_GREY = '#8a8d93';
const BLOOD = '#7a1015';
const BLOOD_DARK = '#4e080c';
const SOOT = 'rgba(28, 26, 24, 0.55)';
const EXPLOSIVES = new Set(['Grenade', 'Frag', 'Land mine', 'Barrel', ...Object.values(GUNS).filter((g) => g.blast).map((g) => g.name)]);

/** Whether the kill feed's `weapon` label names something that explodes. */
export const explosiveDeath = (weapon: string): boolean => EXPLOSIVES.has(weapon);

export function addCorpse(corpses: readonly Corpse[], c: Corpse): Corpse[] {
  return [...corpses.filter((o) => o.victim !== c.victim || c.born - o.born > CORPSE.lifeMs), c].slice(-CORPSE.cap);
}

/** The corpses still lying on `map` at `now`; the rest are dropped. */
export const liveCorpses = (corpses: readonly Corpse[], map: string, now: number): Corpse[] =>
  corpses.filter((c) => c.map === map && now - c.born < CORPSE.lifeMs);

export const corpseAlpha = (c: Corpse, now: number): number => Math.max(0, Math.min(1, (c.born + CORPSE.lifeMs - now) / CORPSE.fadeMs));

/** Washes `color` most of the way to grey (darker still for a burnt body), so the dead never read as a living player of their color. */
export function deadTone(color: string, burnt = false): string {
  const [r, g, b] = deadChannels(color, burnt);
  return `rgb(${r}, ${g}, ${b})`;
}

/** `deadTone` as a hex colour, for the body art to shade. */
export function deadHex(color: string, burnt = false): string {
  const [r, g, b] = deadChannels(color, burnt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function deadChannels(color: string, burnt: boolean): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  const g = parseInt(DEAD_GREY.slice(1), 16);
  const dim = burnt ? 0.55 : 1;
  const mix = (shift: number) => Math.round((((n >> shift) & 255) * 0.2 + ((g >> shift) & 255) * 0.8) * dim);
  return [mix(16), mix(8), mix(0)];
}

/** A per-corpse number in [0, 1), so every corpse falls a little differently but never flickers. */
const seeded = (c: Corpse, k: number) => {
  const v = Math.sin(c.victim * 12.9898 + c.born * 0.001 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const easeOut = (k: number) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;

/** The way the body was thrown: along the blow, or a seeded bearing when the blow's direction is unknown. */
const thrownAlong = (c: Corpse) => c.blow ?? seeded(c, 20) * Math.PI * 2;

/** Where the body comes to rest, knocked a little along the blow, further by a blast. */
function restingBody(c: Corpse, age: number) {
  const knock = CORPSE.knockPx * (c.blast ? 2 : 0.6 + seeded(c, 21) * 0.8) * easeOut(age / CORPSE.dropMs);
  const a = thrownAlong(c);
  return { x: c.x + Math.cos(a) * knock, y: c.y + Math.sin(a) * knock };
}

/** Where the dropped gun comes to rest: any bearing, a seeded distance (flung further by a blast), and any angle, sliding and spinning there. */
export function restingGun(c: Corpse, at: { x: number; y: number }, age: number) {
  const k = easeOut(age / CORPSE.slideMs);
  const bearing = c.blast ? thrownAlong(c) + (seeded(c, 22) - 0.5) * 1.6 : seeded(c, 23) * Math.PI * 2;
  const dist = R * (c.blast ? 2.2 + seeded(c, 24) * 1.4 : 1.35 + seeded(c, 25) * 0.9) * k;
  const spin = (seeded(c, 26) - 0.5) * (c.blast ? 9 : 4) * (1 - k);
  return { x: at.x + Math.cos(bearing) * dist, y: at.y + Math.sin(bearing) * dist, angle: seeded(c, 27) * Math.PI * 2 + spin };
}

function drawPool(ctx: CanvasRenderingContext2D, c: Corpse, at: { x: number; y: number }, grow: number) {
  if (c.blast) {
    ctx.fillStyle = SOOT;
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, R * 2.3, R * 2, seeded(c, 2) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const tilt = seeded(c, 1) * Math.PI;
  const size = 0.8 + seeded(c, 3) * 0.5;
  ctx.fillStyle = BLOOD;
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, R * 1.5 * size * grow, R * 1.1 * size * grow, tilt, 0, Math.PI * 2);
  const drops = 3 + Math.floor(seeded(c, 4) * 5) + (c.blast ? 4 : 0);
  const spray = c.blow;
  for (let i = 0; i < drops; i++) {
    // With a known blow, most drops spray out the far side; otherwise they ring the body.
    const a = spray !== null && i % 3 !== 0 ? spray + (seeded(c, 30 + i) - 0.5) * 1.1 : seeded(c, 30 + i) * Math.PI * 2;
    const d = R * (1.2 + seeded(c, 50 + i) * (spray !== null ? 1.6 : 0.8)) * grow;
    const r = R * (0.12 + seeded(c, 70 + i) * 0.22) * grow;
    ctx.moveTo(at.x + Math.cos(a) * d + r, at.y + Math.sin(a) * d);
    ctx.arc(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, r, 0, Math.PI * 2);
  }
  ctx.fill();
  if (spray !== null) {
    // A smear from the body out along the blow.
    ctx.strokeStyle = BLOOD;
    ctx.lineCap = 'round';
    ctx.lineWidth = R * (0.25 + seeded(c, 5) * 0.2);
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    const len = R * (1.4 + seeded(c, 6) * 1.2) * grow;
    ctx.lineTo(at.x + Math.cos(spray) * len, at.y + Math.sin(spray) * len);
    ctx.stroke();
  }
  ctx.fillStyle = BLOOD_DARK;
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, R * 1.0 * size * grow, R * 0.75 * size * grow, tilt, 0, Math.PI * 2);
  ctx.fill();
}

function drawGunAt(ctx: CanvasRenderingContext2D, c: Corpse, gun: { x: number; y: number; angle: number }) {
  ctx.save();
  ctx.translate(gun.x, gun.y);
  ctx.rotate(gun.angle);
  drawDroppedGun(ctx, c.gun, 0, 0, cosLook(c.cos).skin);
  ctx.restore();
}

function drawBody(ctx: CanvasRenderingContext2D, c: Corpse, at: { x: number; y: number }, drop: number, pxPerUnit: number) {
  const fall = c.angle + (seeded(c, 14) - 0.5) * 1.2;
  // The soldier lies where they fell, greyed out, arms flung wide and the head lolled, then crossed out.
  drawFallenSoldier(ctx, deadHex(c.color, c.blast), at.x, at.y, R, {
    angle: fall, splay: [(seeded(c, 17) - 0.3) * 1.1, (seeded(c, 18) - 0.3) * 1.1], loll: (seeded(c, 19) - 0.5) * 0.3, scale: 1 + 0.12 * (1 - drop), helmet: cosLook(c.cos).helmet, camo: cosLook(c.cos).camo,
  }, pxPerUnit);
  const arm = R * (0.32 + seeded(c, 16) * 0.06);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(fall);
  ctx.lineCap = 'round';
  for (const [width, color] of [[7, 'rgba(255, 255, 255, 0.55)'], [4.5, INK]] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(-arm, -arm);
    ctx.lineTo(arm, arm);
    ctx.moveTo(arm, -arm);
    ctx.lineTo(-arm, arm);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Corpses lie on the ground: under bodies, bullets and the night shade. Each lies in a pool of blood sprayed along the
 * killing blow, its gun dropped at a random spot and angle; an explosive death is scorched, and flings the gun further.
 */
export function drawCorpses(ctx: CanvasRenderingContext2D, corpses: readonly Corpse[], now: number, pxPerUnit = 1) {
  for (const c of corpses) {
    const age = now - c.born;
    const alpha = corpseAlpha(c, now);
    if (alpha <= 0 || age < 0) continue;
    const body = restingBody(c, age);
    ctx.globalAlpha = alpha * 0.85;
    drawPool(ctx, c, body, 0.35 + 0.65 * Math.min(1, age / CORPSE.poolMs));
  }
  // Every pool lies under every gun and body, so neighbouring corpses stack instead of one's blood covering another.
  for (const c of corpses) {
    const age = now - c.born, alpha = corpseAlpha(c, now);
    if (alpha <= 0 || age < 0) continue;
    const body = restingBody(c, age);
    ctx.globalAlpha = alpha;
    drawGunAt(ctx, c, restingGun(c, body, age));
    drawBody(ctx, c, body, Math.min(1, age / CORPSE.dropMs), pxPerUnit);
  }
  ctx.globalAlpha = 1;
}

/** A zombie killed tonight: where it fell, its kind, and the way the killing hit travelled (null for a turret's kill or an unknown killer). */
export type ZombieCorpse = { id: number; x: number; y: number; kind: ZombieKind; born: number; blow: number | null };

/** The most zombie corpses kept in a night, how long the ichor takes to spread, and how long the field takes to fade at dawn. */
/** `lifeMs`: how long a dead zombie lies before it starts to fade, over `fadeMs`, so a night's dead never pile up into a carpet. */
export const ZOMBIE_CORPSE = { cap: 600, poolMs: 900, dawnFadeMs: 2_500, lifeMs: 9_000, fadeMs: 1_500 } as const;

/** Zombie corpses only lie at night, so they are drawn over the night shade in tones that read on the dark floor. */
const ICHOR = 'rgba(96, 138, 44, 0.72)';
const ICHOR_DARK = 'rgba(58, 88, 26, 0.8)';

export const addZombieCorpse = (corpses: readonly ZombieCorpse[], c: ZombieCorpse): ZombieCorpse[] => [...corpses, c].slice(-ZOMBIE_CORPSE.cap);

/**
 * Each dead zombie lies `lifeMs`, then fades out over `fadeMs`; whatever is left when the night ends fades together over `dawnFadeMs`.
 * Returns the kept list, its alpha, and when the dawn fade began.
 */
export function zombieField(field: { list: ZombieCorpse[]; dawnAt: number | null }, night: boolean, now: number): { list: ZombieCorpse[]; dawnAt: number | null; alpha: number } {
  const gone = ZOMBIE_CORPSE.lifeMs + ZOMBIE_CORPSE.fadeMs;
  const kept = field.list.length && now - field.list[0]!.born >= gone ? field.list.filter((c) => now - c.born < gone) : field.list;
  field = kept === field.list ? field : { ...field, list: kept };
  if (night) return { list: field.list, dawnAt: null, alpha: 1 };
  if (!field.list.length) return { list: [], dawnAt: null, alpha: 0 };
  const dawnAt = field.dawnAt ?? now;
  const alpha = 1 - (now - dawnAt) / ZOMBIE_CORPSE.dawnFadeMs;
  return alpha > 0 ? { list: field.list, dawnAt, alpha } : { list: [], dawnAt: null, alpha: 0 };
}

const zSeeded = (c: ZombieCorpse, k: number) => {
  const v = Math.sin(c.id * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Dead zombies lie in dark ichor sprayed away from the hit that killed them, limbs splayed, eyes crossed out. Drawn in a few
 * batched passes per kind, since a night leaves hundreds.
 */
export function drawZombieCorpses(ctx: CanvasRenderingContext2D, corpses: readonly ZombieCorpse[], alpha: number, now: number, pxPerUnit = 1) {
  if (!corpses.length || alpha <= 0) return;
  // The steady dead go in one batch; the few fading out right now each get their own alpha.
  const fadeFrom = now - ZOMBIE_CORPSE.lifeMs;
  if (corpses.some((c) => c.born < fadeFrom)) {
    drawZombieCorpses(ctx, corpses.filter((c) => c.born >= fadeFrom), alpha, now, pxPerUnit);
    // Drawn as it lay at the moment it began to fade (a frozen `now`, so it is not counted as fading again), at its fading alpha.
    for (const c of corpses) if (c.born < fadeFrom) drawZombieCorpses(ctx, [c], alpha * Math.max(0, 1 - (fadeFrom - c.born) / ZOMBIE_CORPSE.fadeMs), c.born + ZOMBIE_CORPSE.lifeMs, pxPerUnit);
    return;
  }
  const grow = (c: ZombieCorpse) => 0.4 + 0.6 * Math.min(1, Math.max(0, now - c.born) / ZOMBIE_CORPSE.poolMs);
  ctx.globalAlpha = alpha;
  for (const [style, scale] of [[ICHOR, 1], [ICHOR_DARK, 0.6]] as const) {
    ctx.fillStyle = style;
    ctx.beginPath();
    for (const c of corpses) {
      const r = ZOMBIES[c.kind].radius * grow(c) * scale;
      ctx.moveTo(c.x + r * 1.5, c.y);
      ctx.ellipse(c.x, c.y, r * 1.5, r * 1.15, zSeeded(c, 1) * Math.PI, 0, Math.PI * 2);
      if (scale < 1) continue;
      const drops = 2 + Math.floor(zSeeded(c, 2) * 4);
      for (let i = 0; i < drops; i++) {
        const a = c.blow !== null && i % 3 !== 0 ? c.blow + (zSeeded(c, 10 + i) - 0.5) * 1.2 : zSeeded(c, 10 + i) * Math.PI * 2;
        const d = r * (1.3 + zSeeded(c, 20 + i) * (c.blow !== null ? 1.4 : 0.6)), dr = r * (0.14 + zSeeded(c, 30 + i) * 0.2);
        ctx.moveTo(c.x + Math.cos(a) * d + dr, c.y + Math.sin(a) * d);
        ctx.arc(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, dr, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  // The dead themselves: each toppled along its killing blow in its own torn kit (zombieart.ts), oldest first so a pile layers.
  newSpriteFrame();
  for (const c of corpses) drawZombieRemains(ctx, c.kind, c.id, c.x, c.y, c.blow, now - c.born, pxPerUnit);
  ctx.globalAlpha = 1;
}
