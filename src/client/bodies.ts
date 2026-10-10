import { INK, PALETTE, shade, shadeHex, tint } from './palette.ts';
import { LIGHT } from './tilt.ts';
import { CEL, celOver, celPart, ellipse, roundBox, TAU, type Trace } from './cel.ts';
import { paintCamo } from './camo.ts';
import { drawPropeller, HELMETS, helmetReach, type HeadKit } from './hats.ts';

const SCALE_STEP = 20;
const RIM = 1.8;
const SHADOW_SHIFT = 0.55;
const SHADOW_FEATHER = 1.3;

/**
 * Sprites per drawn scale. The world, a celebration podium and the menu's previews draw soldiers at different scales in the
 * same frame, so the few most recent scales each keep their own sprites (a zoom only ever adds one at a time) rather than
 * one cache flushed whenever the scale changes, which repainted every sprite every frame while two scales alternated.
 */
const byScale = new Map<number, Map<string, HTMLCanvasElement>>();
const SCALES_KEPT = 4;
let lastScale = 0;

function canvas(side: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(side);
  return [c, c.getContext('2d')!];
}

function cached(key: string, pxPerUnit: number, paint: (px: number) => HTMLCanvasElement): HTMLCanvasElement {
  const px = Math.round(pxPerUnit * SCALE_STEP) / SCALE_STEP;
  let sprites = byScale.get(px);
  if (sprites) { if (lastScale !== px) { byScale.delete(px); byScale.set(px, sprites); } }
  else {
    byScale.set(px, (sprites = new Map()));
    for (const old of byScale.keys()) { if (byScale.size <= SCALES_KEPT) break; byScale.delete(old); }
  }
  lastScale = px;
  let image = sprites.get(key);
  if (!image) sprites.set(key, (image = paint(px)));
  return image;
}

function disc(g: CanvasRenderingContext2D, r: number, fill: string | CanvasGradient) {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();
}

export function bodySprite(color: string, radius: number, armor: number, pxPerUnit: number): HTMLCanvasElement {
  return cached(`${color}|${radius}|${armor}`, pxPerUnit, (px) => {
    const [c, g] = canvas((radius + 1) * 2 * px);
    g.scale(px, px);
    g.translate(radius + 1, radius + 1);
    disc(g, radius, INK);
    const r = radius - RIM - armor;
    // Cel-shaded like the walls and guns: a hard darker crescent away from the light, a hard lighter one toward it.
    g.save();
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.clip();
    disc(g, r, shade(color, 0.8));
    g.translate(-r * CEL.shadeShift, -r * CEL.shadeShift);
    disc(g, r, color);
    g.translate(r * CEL.shadeShift, r * CEL.shadeShift);
    g.fillStyle = tint(color, 0.32);
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.arc(r * CEL.lightShift, r * CEL.lightShift, r, 0, Math.PI * 2, true);
    g.fill();
    g.restore();
    return c;
  });
}

const tiles = new Map<string, HTMLCanvasElement>();
/** A square of camo over `base` to fill a sleeve with, `R` radii wide at scale `px`, cached by colour and pattern. */
function camoTile(camo: string, base: string, R: number, px: number): HTMLCanvasElement {
  const key = `${camo}|${base}|${R}|${px}`;
  let tile = tiles.get(key);
  if (!tile) {
    if (tiles.size > 120) tiles.clear();
    const side = R * 2.2;
    const [c, g] = canvas(side * px);
    g.scale(px, px);
    g.fillStyle = shade(base, 0.86);
    g.fillRect(0, 0, side, side);
    g.translate(side / 2, side / 2);
    paintCamo(camo, { g, W: R * 0.9, H: R * 0.9, R, color: base });
    tiles.set(key, (tile = c));
  }
  return tile;
}

export function drawBody(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement, x: number, y: number, radius: number) {
  ctx.drawImage(image, x - radius - 1, y - radius - 1, (radius + 1) * 2, (radius + 1) * 2);
}

function shadowSprite(radius: number, pxPerUnit: number): HTMLCanvasElement {
  return cached(`shadow|${radius}`, pxPerUnit, (px) => {
    const reach = radius * SHADOW_FEATHER;
    const [c, g] = canvas(reach * 2 * px);
    g.scale(px, px);
    const fade = g.createRadialGradient(reach, reach, radius * 0.6, reach, reach, reach);
    fade.addColorStop(0, PALETTE.contact);
    fade.addColorStop(1, 'rgba(20, 24, 32, 0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, reach * 2, reach * 2);
    return c;
  });
}

export function drawBodyShadows(ctx: CanvasRenderingContext2D, bodies: readonly { x: number; y: number; r: number }[], pxPerUnit: number) {
  for (const b of bodies) {
    const reach = b.r * SHADOW_FEATHER;
    ctx.drawImage(shadowSprite(b.r, pxPerUnit), b.x + LIGHT.x * b.r * SHADOW_SHIFT - reach, b.y + LIGHT.y * b.r * SHADOW_SHIFT - reach, reach * 2, reach * 2);
  }
}

/**
 * Players are stylized soldiers seen from straight above, facing +x in their own frame: a pill of shoulders and torso in
 * the player's colour with a pack on the back, a helmet in the same colour with goggles to the front, two sleeved arms out
 * to gloved hands on the gun, and boots that step out from under the body while walking. Armor shows as gunmetal kit over
 * the shirt: a plate carrier (light), shoulder pauldrons too (medium), big pauldrons and a collar (heavy). Gear wears the
 * kit's neutral tones so the colour stays the identity. The parts that turn with the aim are cached per angle bucket, so
 * their cel shading always falls away from the world's light, and drawn turned by the small remainder.
 * Every size below is a share of the body radius.
 */
export const SOLDIER = {
  torso: { cx: -0.08, rx: 0.5, ry: 0.86 },
  pack: { x0: -0.76, x1: -0.3, half: 0.4, round: 0.14 },
  head: { cx: 0.04, r: 0.41 },
  shoulder: { x: -0.06, y: 0.68 },
  arm: 0.19,
  hand: 0.185,
  boot: { rx: 0.25, ry: 0.17, side: 0.33, reach: 0.55 },
  ink: 0.085,
} as const;

export const GEAR = {
  pack: '#6a7255', strap: '#3f4433', boot: '#33312d', glove: '#cdb88c', carrier: '#4f5661', plate: '#7d8693',
  goggle: '#2c3037', lens: '#9cd0ea',
} as const;

type ArmorTier = 'none' | 'light' | 'medium' | 'heavy';
const CONTACT = 'rgba(10, 12, 18, 0.32)';
const BUCKETS = 32;
/** How much of the torso's top face a camo may cover; the rest is a rim of the player's colour. */
const CAMO_FACE = 0.86;

/** The nearest cached angle bucket for `angle`, and the remainder to turn the cached sprite by. */
export function angleBucket(angle: number): { index: number; rest: number } {
  const step = TAU / BUCKETS;
  const raw = Math.round(angle / step);
  return { index: ((raw % BUCKETS) + BUCKETS) % BUCKETS, rest: angle - raw * step };
}

/** How far the torso sprite reaches from the body's centre, in radii. */
const TORSO_REACH = 1.2;
/** Heights, in radii, of the stacked parts seen at the three-quarter angle: each part's `rise` off the ground and `lip` deep. */
export const STACK = {
  torso: { rise: -0.12, lip: 0.24 }, carrier: { rise: 0.12, lip: 0.06 }, pack: { rise: -0.08, lip: 0.34 },
  pauldron: { rise: 0.02, lip: 0.16 }, head: { rise: 0.2, lip: 0.14 },
} as const;

/** The shoulders, torso, pack and armor, turned to angle bucket `index`. */
function torsoSprite(color: string, radius: number, armor: ArmorTier, index: number, pxPerUnit: number, camo = 'c_plain'): HTMLCanvasElement {
  return cached(`torso|${color}|${radius}|${armor}|${index}|${camo}`, pxPerUnit, (px) => {
    const half = radius * TORSO_REACH + 2;
    const [c, g] = canvas(half * 2 * px);
    const turn = (index / BUCKETS) * TAU;
    g.scale(px, px);
    g.translate(half, half);
    g.rotate(turn);
    const R = radius, ink = SOLDIER.ink * R;
    const up = (h: number): [number, number] => [-h * R * Math.sin(turn), -h * R * Math.cos(turn)];
    const part = (trace: Trace, base: string, size: number, at: { rise: number; lip: number }, inkW = ink) =>
      celPart(g, trace, base, turn, size, inkW, at.lip * R, at.rise * R);
    const { torso: t, pack: k } = SOLDIER;
    // Heavier armor rides on a broader frame.
    const broad = armor === 'heavy' ? 1.04 : 1;
    part(ellipse(t.cx * R, 0, t.rx * R * broad, t.ry * R * broad), color, t.rx * R, STACK.torso);
    // A camo prints on a part's top face, inside a rim of the part's own colour, and takes the same two cel steps.
    const printCamo = (face: Trace, cx: number, W: number, H: number, rise: number) => {
      if (camo === 'c_plain') return;
      const [ox, oy] = up(rise);
      g.save();
      g.translate(ox, oy);
      g.beginPath();
      face(g);
      g.clip();
      g.translate(cx, 0);
      paintCamo(camo, { g, W, H, R, color });
      g.restore();
      g.save();
      g.translate(ox, oy);
      celOver(g, face, turn, W);
      g.restore();
    };
    printCamo(ellipse(t.cx * R, 0, t.rx * R * broad * CAMO_FACE, t.ry * R * broad * CAMO_FACE), t.cx * R, t.rx * R * broad, t.ry * R * broad, STACK.torso.rise + STACK.torso.lip);
    if (camo !== 'c_plain') {
      // The torso's front face, the crescent that shows below the helmet, carries the pattern too, a step darker than the top.
      const lipTrace: Trace = (c) => {
        for (let i = 0; i <= 4; i++) {
          const [ox, oy] = up(STACK.torso.rise + (STACK.torso.lip * i) / 4);
          c.save(); c.translate(ox, oy); ellipse(t.cx * R, 0, t.rx * R * broad * CAMO_FACE, t.ry * R * broad * CAMO_FACE)(c); c.restore();
        }
      };
      const [tx0, ty0] = up(STACK.torso.rise + STACK.torso.lip);
      g.save();
      g.beginPath();
      lipTrace(g);
      // Not the top face again: only what the lip adds below it.
      g.translate(tx0, ty0);
      ellipse(t.cx * R, 0, t.rx * R * broad * CAMO_FACE, t.ry * R * broad * CAMO_FACE)(g);
      g.translate(-tx0, -ty0);
      g.clip('evenodd');
      const [mx, my] = up(STACK.torso.rise + STACK.torso.lip * 0.5);
      g.translate(mx + t.cx * R, my);
      paintCamo(camo, { g, W: t.rx * R * broad, H: t.ry * R * broad, R, color });
      g.translate(-mx - t.cx * R, -my);
      g.fillStyle = 'rgba(10, 12, 20, 0.34)';
      g.fillRect(-R * 2, -R * 2, R * 4, R * 4);
      g.restore();
    }
    // Webbing: two straps over the shoulders to the pack, on the torso's top face.
    const [sx, sy] = up(STACK.torso.rise + STACK.torso.lip);
    g.translate(sx, sy);
    g.strokeStyle = GEAR.strap;
    g.lineCap = 'round';
    g.lineWidth = R * 0.09;
    g.beginPath();
    for (const side of [-1, 1]) {
      g.moveTo(k.x1 * R, side * k.half * R * 0.75);
      g.quadraticCurveTo(-0.02 * R, side * 0.62 * R, 0.3 * R, side * 0.42 * R);
    }
    g.stroke();
    g.translate(-sx, -sy);
    if (armor !== 'none') {
      // A plate carrier: the plates' top edges and the cummerbund round the chest, framing the helmet.
      const w = armor === 'heavy' ? 0.56 : 0.5;
      part(roundBox(-0.44 * R, -w * R, 0.36 * R, w * R, 0.2 * R), GEAR.carrier, 0.4 * R, STACK.carrier, ink * 0.8);
      const [cx, cy] = up(STACK.carrier.rise + STACK.carrier.lip);
      g.fillStyle = 'rgba(0, 0, 0, 0.3)';
      for (const side of [-1, 1]) g.fillRect(0.12 * R + cx, side * w * R * 0.6 - 0.06 * R + cy, 0.18 * R, 0.12 * R);
      // A camo vest: the pattern over the plates, inside a gunmetal edge.
      printCamo(roundBox(-0.38 * R, -(w - 0.07) * R, 0.3 * R, (w - 0.07) * R, 0.14 * R), -0.04 * R, 0.4 * R, w * R, STACK.carrier.rise + STACK.carrier.lip);
    }
    part(roundBox(k.x0 * R, -k.half * R, k.x1 * R, k.half * R, k.round * R), GEAR.pack, 0.3 * R, STACK.pack);
    const [px0, py0] = up(STACK.pack.rise + STACK.pack.lip);
    g.fillStyle = 'rgba(0, 0, 0, 0.25)';
    g.fillRect(k.x0 * R + 0.1 * R + px0, -0.04 * R + py0, (k.x1 - k.x0 - 0.2) * R, 0.08 * R);
    if (armor === 'medium' || armor === 'heavy') {
      // Pauldrons: curved plates capping each shoulder in the wearer's colour, so armor never hides who it is, with a steel
      // rim and rivets; heavy armor's are longer and layered.
      const big = armor === 'heavy';
      const [ux, uy] = up(STACK.pauldron.rise + STACK.pauldron.lip);
      for (const side of [-1, 1]) {
        const plates = big ? [[-0.44, 0.32, 0.5, 1.0], [-0.3, 0.18, 0.6, 0.92]] : [[-0.34, 0.22, 0.54, 0.9]];
        for (const [x0, x1, y0, y1] of plates) {
          const ya = side * y0! * R, yb = side * y1! * R;
          const trace = roundBox(x0! * R, Math.min(ya, yb), x1! * R, Math.max(ya, yb), 0.13 * R);
          part(trace, shadeHex(color, 0.92), 0.2 * R, STACK.pauldron);
          g.save();
          g.translate(ux, uy);
          g.beginPath();
          trace(g);
          g.clip();
          g.strokeStyle = GEAR.plate;
          g.lineWidth = R * 0.14;
          g.beginPath();
          trace(g);
          g.stroke();
          g.restore();
          g.fillStyle = INK;
          g.beginPath();
          for (const fx of [0.25, 0.75]) {
            const rx = (x0! + (x1! - x0!) * fx) * R + ux, ry = side * (y0! + y1!) * 0.5 * R + uy;
            g.moveTo(rx + 0.035 * R, ry);
            g.arc(rx, ry, 0.035 * R, 0, TAU);
          }
          g.fill();
        }
      }
    }
    return c;
  });
}

/** The head sprite's half-size, in px: the head's lift plus the farthest a helmet style reaches, in head radii. */
export const headHalf = (radius: number, helmet = 'h_standard'): number => (STACK.head.rise + STACK.head.lip) * radius + Math.max(1, helmetReach(helmet)) * SOLDIER.head.r * radius + 2;

/** The helmet in the player's colour, goggles to the front, turned to angle bucket `index`; a helmet cosmetic swaps the style. */
function headSprite(color: string, radius: number, index: number, pxPerUnit: number, helmet = 'h_standard'): HTMLCanvasElement {
  return cached(`head|${color}|${radius}|${index}|${helmet}`, pxPerUnit, (px) => {
    const R = radius, r = SOLDIER.head.r * R;
    const half = headHalf(R, helmet);
    const [c, g] = canvas(half * 2 * px);
    const turn = (index / BUCKETS) * TAU;
    g.scale(px, px);
    g.translate(half, half);
    const style = helmet === 'h_standard' ? undefined : HELMETS[helmet];
    if (style) {
      const T = (STACK.head.rise + STACK.head.lip) * R, ink = SOLDIER.ink * R;
      const kit: HeadKit = {
        g, u: r, T, ink, lip: STACK.head.lip * R, a: turn, color,
        xy: (f, s) => [(f * Math.cos(turn) - s * Math.sin(turn)) * r, (f * Math.sin(turn) + s * Math.cos(turn)) * r],
        part: (trace, base, lip = 0, rise = T, size = r) => celPart(g, trace, base, 0, size, ink, lip, rise),
      };
      style.paint(kit);
      return c;
    }
    g.rotate(turn);
    const top = STACK.head.rise + STACK.head.lip;
    celPart(g, ellipse(0, 0, r, r), shadeHex(color, 0.92), turn, r, SOLDIER.ink * R, STACK.head.lip * R, STACK.head.rise * R);
    g.translate(-top * R * Math.sin(turn), -top * R * Math.cos(turn));
    // The helmet's cover band, a seam across the crown.
    g.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    g.lineWidth = R * 0.06;
    g.beginPath();
    g.arc(0, 0, r * 0.62, Math.PI * 0.62, Math.PI * 1.38);
    g.stroke();
    // Goggles: a dark strap round the front of the helmet with two lenses.
    g.strokeStyle = GEAR.goggle;
    g.lineWidth = R * 0.11;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, 0, r - R * 0.08, -0.72, 0.72);
    g.stroke();
    g.fillStyle = GEAR.lens;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.arc(Math.cos(side * 0.36) * (r - R * 0.08), Math.sin(side * 0.36) * (r - R * 0.08), R * 0.05, 0, TAU);
      g.fill();
    }
    return c;
  });
}

function drawTurned(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement, half: number, rest: number) {
  if (rest !== 0) ctx.rotate(rest);
  ctx.drawImage(image, -half, -half, half * 2, half * 2);
  if (rest !== 0) ctx.rotate(-rest);
}

/**
 * A walk cycle from the positions a body was drawn at: speed smoothed over a few frames, a stepping phase that advances
 * with the distance walked (half a turn per `step`), and the heading the feet step along.
 */
export type Gait = { x: number; y: number; t: number; phase: number; speed: number; heading: number };
export const GAIT = { step: 34, fullSpeed: 220, smoothMs: 90, staleMs: 500, jump: 120 } as const;

export function stepGait(prev: Gait | undefined, x: number, y: number, now: number): Gait {
  if (!prev || now - prev.t > GAIT.staleMs) return { x, y, t: now, phase: 0, speed: 0, heading: 0 };
  const dt = now - prev.t;
  if (dt <= 0) return prev;
  const dx = x - prev.x, dy = y - prev.y, d = Math.hypot(dx, dy);
  // A respawn or a teleport is not a stride.
  if (d > GAIT.jump) return { x, y, t: now, phase: prev.phase, speed: 0, heading: prev.heading };
  const a = 1 - Math.exp(-dt / GAIT.smoothMs);
  return {
    x, y, t: now,
    phase: (prev.phase + (d / GAIT.step) * Math.PI) % TAU,
    speed: prev.speed + ((d / dt) * 1000 - prev.speed) * a,
    heading: d > 0.05 ? Math.atan2(dy, dx) : prev.heading,
  };
}

/** How far into a full stride a gait is, 0 standing to 1 at a run. */
export const gaitAmount = (g: Gait | undefined): number => (g ? Math.max(0, Math.min(1, g.speed / GAIT.fullSpeed)) : 0);

/** How a walking body sways: the shoulders' twist, and each boot's offset along the heading, in radii. */
export function walkPose(g: Gait | undefined, sprint = 0): { twist: number; stride: number; amount: number } {
  const amount = gaitAmount(g);
  const swing = g ? Math.sin(g.phase) : 0;
  // A sprint swings wider and longer.
  return { twist: swing * 0.11 * amount * (1 + 1.2 * sprint), stride: swing * SOLDIER.boot.reach * amount * (1 + 0.8 * sprint), amount };
}

/**
 * The sprint pose at full: the gun is carried across the chest at `tilt` radians (well off the aim, so a sprinter reads as unable to
 * shoot at a glance), pulled `pull` radii in, and the head leans `lean` radii forward.
 */
export const SPRINT_POSE = { tilt: -1.2, pull: 0.32, lean: 0.16 } as const;

export type SoldierLook = {
  angle: number; armor: ArmorTier;
  /** World positions of the hands relative to the body, in the body's frame, already pushed back by recoil. */
  hands: readonly [{ x: number; y: number }, { x: number; y: number }];
  /** How far recoil pushes the gun back, in world units; the shoulders take a share. */
  jump: number;
  gait?: Gait;
  /** Draws the gun in the body's frame (x along the aim), between the shoulders and the hands. */
  gun?: (ctx: CanvasRenderingContext2D) => void;
  /** 0..1 white hit flash over the body. */
  flash: number;
  /** Skip the contact shadow, when the caller keeps one on the floor itself (a body falling in from above). */
  noShadow?: boolean;
  /** Cosmetics: the helmet style and camo pattern (catalog ids; the defaults when absent), and the propeller beanie's spin in radians. */
  helmet?: string;
  camo?: string;
  spin?: number;
  /**
   * 0..1, how far into a sprint: the gun swings down across the chest, the stride lengthens and the head leans in (see `SPRINT_POSE`).
   * A little below 0 swings the gun just past the aim the other way, the overshoot as it comes up after a sprint (see raise.ts).
   */
  sprint?: number;
};

/** Draws a soldier at (`x`, `y`): boots, arms, torso, gun, gloves, helmet, in that order from the ground up. */
export function drawSoldier(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number, look: SoldierLook, pxPerUnit: number) {
  const R = radius, ink = SOLDIER.ink * R;
  const swing = Math.max(-0.3, Math.min(1, look.sprint ?? 0));
  const sp = Math.max(0, swing);
  const pose = walkPose(look.gait, sp);
  // Sprinting, the whole gun-and-hands assembly turns across the chest and tucks in; past the aim (below 0), it only turns.
  const tilt = SPRINT_POSE.tilt * swing, pull = SPRINT_POSE.pull * R * sp;
  const hands = (swing !== 0 ? look.hands.map((h) => ({ x: h.x * Math.cos(tilt) - h.y * Math.sin(tilt) - pull, y: h.x * Math.sin(tilt) + h.y * Math.cos(tilt) })) : look.hands) as SoldierLook['hands'];
  ctx.save();
  ctx.translate(x, y);
  // A crisp contact shadow where the boots meet the floor, a little down-screen.
  if (!look.noShadow) {
    ctx.fillStyle = CONTACT;
    ctx.beginPath();
    ctx.ellipse(LIGHT.x * R * 0.12, R * 0.3, R * 0.82, R * 0.46, 0, 0, TAU);
    ctx.fill();
  }
  if (pose.amount > 0.04 && look.gait) {
    // Boots step out fore and aft along the way the body is going.
    const h = look.gait.heading, hc = Math.cos(h), hs = Math.sin(h);
    ctx.fillStyle = GEAR.boot;
    ctx.strokeStyle = INK;
    ctx.lineWidth = ink * 1.6;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      const along = side * pose.stride * R, across = side * SOLDIER.boot.side * R;
      const bx = hc * along - hs * across, by = hs * along + hc * across;
      ctx.moveTo(bx + hc * SOLDIER.boot.rx * R, by + hs * SOLDIER.boot.rx * R);
      ctx.ellipse(bx, by, SOLDIER.boot.rx * R, SOLDIER.boot.ry * R, h, 0, TAU);
    }
    ctx.stroke();
    ctx.fill();
  }
  ctx.rotate(look.angle);
  const back = look.jump * 0.4;
  const twist = pose.twist;
  // Arms from the shoulders (turned by the walk's twist and pushed back by recoil) to the hands.
  const shoulder = (side: number) => {
    const sx = SOLDIER.shoulder.x * R, sy = side * SOLDIER.shoulder.y * R;
    return { x: sx * Math.cos(twist) - sy * Math.sin(twist) - back, y: sx * Math.sin(twist) + sy * Math.cos(twist) };
  };
  const [trigger, support] = hands;
  const arms = [[shoulder(1), trigger], [shoulder(-1), support]] as const;
  // A long reach (a rifle held out ahead, aimed up- or down-screen) would draw as a thin wedge, so the elbow bows out and the
  // sleeve thickens with the reach: every aim keeps a chunky, bent arm.
  const reach = (from: { x: number; y: number }, to: { x: number; y: number }) => Math.max(0, Math.min(1, (Math.hypot(to.x - from.x, to.y - from.y) / R - 1.1) / 1.0));
  const elbow = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    ({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + (from.y >= 0 ? 1 : -1) * R * (0.08 + 0.12 * reach(from, to)) });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let sleeve: string | CanvasPattern = shade(color, 0.86);
  if (look.camo && look.camo !== 'c_plain') {
    const pat = ctx.createPattern(camoTile(look.camo, color, R, pxPerUnit), 'repeat');
    if (pat) { pat.setTransform(new DOMMatrix().scale(1 / pxPerUnit).translate(-R * 1.1 * pxPerUnit, -R * 1.1 * pxPerUnit)); sleeve = pat; }
  }
  for (const [width, style] of [[SOLDIER.arm * R + ink * 2, INK], [SOLDIER.arm * R, sleeve]] as const) {
    for (const [from, to] of arms) {
      const m = elbow(from, to);
      ctx.lineWidth = width * (1 + 0.35 * reach(from, to));
      ctx.strokeStyle = style;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(m.x, m.y, to.x, to.y);
      ctx.stroke();
    }
  }
  // A shade along each sleeve's far side from the light, as on every other part.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
  const lx = LIGHT.x * Math.cos(look.angle) + LIGHT.y * Math.sin(look.angle), ly = -LIGHT.x * Math.sin(look.angle) + LIGHT.y * Math.cos(look.angle);
  const off = SOLDIER.arm * R * 0.3;
  for (const [from, to] of arms) {
    const m = elbow(from, to);
    ctx.lineWidth = SOLDIER.arm * R * 0.35 * (1 + 0.35 * reach(from, to));
    ctx.beginPath();
    ctx.moveTo(from.x + lx * off, from.y + ly * off);
    ctx.quadraticCurveTo(m.x + lx * off, m.y + ly * off, to.x + lx * off, to.y + ly * off);
    ctx.stroke();
  }

  // The cached sprites face their bucket's angle in the world's frame; turn them by the rest of the aim and the twist.
  const { index, rest } = angleBucket(look.angle);
  ctx.translate(-back, 0);
  ctx.rotate(-look.angle);
  drawTurned(ctx, torsoSprite(color, R, look.armor, index, pxPerUnit, look.camo), R * TORSO_REACH + 2, rest + twist);
  ctx.rotate(look.angle);
  ctx.translate(back, 0);
  if (swing !== 0 && look.gun) {
    ctx.save();
    ctx.translate(-pull, 0);
    ctx.rotate(tilt);
    look.gun(ctx);
    ctx.restore();
  } else look.gun?.(ctx);
  ctx.fillStyle = GEAR.glove;
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 2;
  ctx.beginPath();
  for (const h of hands) {
    ctx.moveTo(h.x + SOLDIER.hand * R, h.y);
    ctx.arc(h.x, h.y, SOLDIER.hand * R, 0, TAU);
  }
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  for (const h of hands) {
    ctx.moveTo(h.x - lx * R * 0.06 + R * 0.07, h.y - ly * R * 0.06);
    ctx.arc(h.x - lx * R * 0.06, h.y - ly * R * 0.06, R * 0.07, 0, TAU);
  }
  ctx.fill();
  const headX = SOLDIER.head.cx * R - look.jump * 0.3 + SPRINT_POSE.lean * R * sp;
  ctx.translate(headX, 0);
  ctx.rotate(-look.angle);
  drawTurned(ctx, headSprite(color, R, index, pxPerUnit, look.helmet), headHalf(R, look.helmet), rest + twist * 0.5);
  if (look.helmet === 'h_propeller') drawPropeller(ctx, SOLDIER.head.r * R, (STACK.head.rise + STACK.head.lip) * R, STACK.head.lip * R, look.spin ?? 0, gaitAmount(look.gait));
  ctx.rotate(look.angle);
  ctx.translate(-headX, 0);
  if (look.flash > 0) {
    ctx.globalAlpha *= look.flash * 0.8;
    ctx.fillStyle = '#ffffff';
    // Over each part's top face, which the three-quarter view lifts up-screen.
    const ux = -Math.sin(look.angle) * R, uy = -Math.cos(look.angle) * R;
    const torsoUp = STACK.torso.rise + STACK.torso.lip, headUp = STACK.head.rise + STACK.head.lip;
    ctx.beginPath();
    ctx.translate(-back + ux * torsoUp, uy * torsoUp);
    ctx.rotate(twist);
    ellipse(SOLDIER.torso.cx * R, 0, SOLDIER.torso.rx * R, SOLDIER.torso.ry * R)(ctx);
    ctx.rotate(-twist);
    ctx.translate(back - ux * torsoUp, -uy * torsoUp);
    ellipse(headX + ux * headUp, uy * headUp, SOLDIER.head.r * R, SOLDIER.head.r * R)(ctx);
    for (const h of hands) ellipse(h.x, h.y, SOLDIER.hand * R, SOLDIER.hand * R)(ctx);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A fallen soldier, for corpses, lying flat on the ground along `angle` (the head's end): a long contact shadow, the legs
 * stretched out behind to two boots, the arms flung out at `splay` (radians off straight sideways, one per arm), the same
 * torso as the living, and the head past the shoulders, lolled `loll` radii to one side. `scale` swells the body a little
 * while it drops, and `stretch` (0..1) is how far the legs have slid out from under it.
 */
export function drawFallenSoldier(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number, pose: { angle: number; splay: readonly [number, number]; loll: number; scale: number; stretch?: number; legs?: readonly [number, number]; helmet?: string; camo?: string }, pxPerUnit: number) {
  const R = radius, ink = SOLDIER.ink * R;
  const stretch = pose.stretch ?? 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pose.scale, pose.scale);
  ctx.rotate(pose.angle);
  // Flat on the ground, the whole length of the body darkens the floor under it.
  ctx.fillStyle = CONTACT;
  ctx.beginPath();
  ctx.ellipse(-R * 0.4, 0, R * (0.95 + 0.55 * stretch), R * 0.78, 0, 0, TAU);
  ctx.fill();
  // The legs, out behind the hips and a little apart, each ending in a boot.
  const legs = ([1, -1] as const).map((side, i) => {
    const hip = { x: -R * 0.42, y: side * R * 0.24 };
    const len = R * (0.55 + 0.6 * stretch), out = (pose.legs?.[i] ?? 0.2) * stretch;
    return { hip, foot: { x: hip.x - Math.cos(out) * len, y: hip.y + side * Math.sin(out) * len }, a: Math.PI - side * out };
  });
  ctx.lineCap = 'round';
  for (const [width, style] of [[SOLDIER.arm * R * 1.7 + ink * 2, INK], [SOLDIER.arm * R * 1.7, shade(color, 0.62)]] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.beginPath();
    for (const { hip, foot } of legs) {
      ctx.moveTo(hip.x, hip.y);
      ctx.lineTo(foot.x, foot.y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = GEAR.boot;
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 2;
  ctx.beginPath();
  for (const { foot, a } of legs) {
    const bx = foot.x + Math.cos(a) * R * 0.06, by = foot.y + Math.sin(a) * R * 0.06;
    ctx.moveTo(bx + Math.cos(a) * SOLDIER.boot.rx * R, by + Math.sin(a) * SOLDIER.boot.rx * R);
    ctx.ellipse(bx, by, SOLDIER.boot.rx * R, SOLDIER.boot.ry * R * 1.15, a, 0, TAU);
  }
  ctx.stroke();
  ctx.fill();
  const arms = ([1, -1] as const).map((side, i) => {
    const sx = SOLDIER.shoulder.x * R, sy = side * SOLDIER.shoulder.y * R;
    const a = side * (Math.PI / 2 + pose.splay[i]!);
    return { from: { x: sx, y: sy }, to: { x: sx + Math.cos(a) * R * 0.85, y: sy + Math.sin(a) * R * 0.85 } };
  });
  for (const [width, style] of [[SOLDIER.arm * R + ink * 2, INK], [SOLDIER.arm * R, shade(color, 0.86)]] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.beginPath();
    for (const { from, to } of arms) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = GEAR.glove;
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 2;
  ctx.beginPath();
  for (const { to } of arms) {
    ctx.moveTo(to.x + SOLDIER.hand * R, to.y);
    ctx.arc(to.x, to.y, SOLDIER.hand * R, 0, TAU);
  }
  ctx.stroke();
  ctx.fill();
  const { index, rest } = angleBucket(pose.angle);
  ctx.rotate(-pose.angle);
  drawTurned(ctx, torsoSprite(color, R, 'none', index, pxPerUnit, pose.camo), R * TORSO_REACH + 2, rest);
  ctx.rotate(pose.angle);
  // Lying down, the head rests past the shoulders instead of on top of them.
  const hx = R * 0.76, hy = pose.loll * R;
  ctx.translate(hx, hy);
  ctx.rotate(-pose.angle);
  drawTurned(ctx, headSprite(color, R, index, pxPerUnit, pose.helmet), headHalf(R, pose.helmet), rest);
  ctx.restore();
}
