import type { Pt } from '../../shared/geom.ts';
import { INK } from '../palette.ts';
import { onMapChange } from '../mapscope.ts';

/**
 * Shared bits of the Harbour theme: its palette, a clock that holds still under `prefers-reduced-motion`, a few shape helpers
 * and a small sprite cache so a painted thing (a container, a gunwale, a bollard) is drawn once and stamped every frame.
 */

export const TAU = Math.PI * 2;

export const C = {
  ink: INK,
  // Water: two cel steps of blue-green, a shallow turquoise and a foam of the bone family.
  deep: '#1d4658', mid: '#2a6173', light: '#3a8896', shallow: '#47a3a6', far: '#173a4a', foam: '#e4ebe0', foamLo: '#b9cbc8', caustic: '#8fd6cc',
  // Stone, asphalt and timber.
  quay: '#6f7479', quayHi: '#8a8f93', quayLo: '#555a60', quaySeam: '#3d4146', coping: '#9a9d9a', quayFace: '#4a4f56',
  asphalt: '#4d5054', asphaltHi: '#5b5f63', asphaltLo: '#3f4246', paint: '#c8a53c', paintWhite: '#d8d4c4',
  cobble: '#7d776a', cobbleHi: '#928b7b', cobbleLo: '#615c52',
  plank: '#8a6a46', plankHi: '#a38358', plankLo: '#5e4630',
  deck: '#6f6b5f', deckHi: '#85806f', deckLo: '#55524a', deckGreen: '#5a6a58',
  steel: '#7e8a96', steelHi: '#9aa6b2', steelLo: '#4f5864', rust: '#a8552e', rustLo: '#7a3a1e',
  white: '#dcd8c8', navy: '#2c3e57', navyHi: '#3d557a', red: '#b4442e', gull: '#e8e6dc',
  lamp: '#ffb347',
} as const;

/** Container paints: faded, chalky, chunky. */
export const BOX_PAINT = ['#a8442e', '#3f6b8c', '#b58e32', '#4d7a52', '#8c9399', '#2f7f86', '#c46a2a', '#d6ccb0', '#7a3a4a', '#5a5f8c'] as const;
/** Fictional shipping lines painted on the boxes (never real ones). */
export const LINES = ['KESTREL', 'ORCA', 'BLUE HERON', 'NORDVIK', 'MAGPIE', 'TIDEWAY', 'SALTGRAIN', 'PELICAN'] as const;

export const hexA = (hex: string, a: number): string => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Math.min(1, Math.max(0, a)).toFixed(3)})`;
};
export const mix = (hex: string, to: number, t: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/** Deterministic noise from two integers. */
export const hash2 = (x: number, y: number): number => {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const calm = (() => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
/** Time for slow motion: frozen at a pretty moment under reduced motion. */
export const clock = (now: number): number => (calm ? 5200 : now);

export const inView = (v: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number, r: number): boolean => x + r >= v.x0 && x - r <= v.x1 && y + r >= v.y0 && y - r <= v.y1;

export const trace = (g: CanvasRenderingContext2D, pts: readonly Pt[]): void => {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
};

/** A rounded rectangle path. */
export const rrect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  const k = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.arcTo(x + w, y, x + w, y + k, k);
  g.lineTo(x + w, y + h - k); g.arcTo(x + w, y + h, x + w - k, y + h, k);
  g.lineTo(x + k, y + h); g.arcTo(x, y + h, x, y + h - k, k);
  g.lineTo(x, y + k); g.arcTo(x, y, x + k, y, k);
  g.closePath();
};

export type Sprite = { canvas: HTMLCanvasElement; ox: number; oy: number; w: number; h: number };
const SPRITES = new Map<string, Sprite>();
onMapChange(() => SPRITES.clear());
const SCALE = 2;

/** A painted thing cached by key: `paint` draws in world units with (0, 0) at the box's top-left, `pad` px of margin all round. */
export function sprite(key: string, w: number, h: number, pad: number, paint: (g: CanvasRenderingContext2D) => void): Sprite {
  let s = SPRITES.get(key);
  if (s) return s;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil((w + pad * 2) * SCALE));
  c.height = Math.max(1, Math.ceil((h + pad * 2) * SCALE));
  const g = c.getContext('2d')!;
  g.setTransform(SCALE, 0, 0, SCALE, pad * SCALE, pad * SCALE);
  paint(g);
  s = { canvas: c, ox: -pad, oy: -pad, w: w + pad * 2, h: h + pad * 2 };
  SPRITES.set(key, s);
  return s;
}

/** Stamps a sprite with its box's top-left at (x, y). */
export const stamp = (g: CanvasRenderingContext2D, s: Sprite, x: number, y: number): void => { g.drawImage(s.canvas, x + s.ox, y + s.oy, s.w, s.h); };

/** Bone lettering on a plate, centred at (x, y). */
export function plate(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fg = '#ece6d6', bg = '#2f343c', edge = '#b79a4a'): void {
  g.save();
  g.font = `700 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  (g as unknown as { letterSpacing: string }).letterSpacing = `${Math.max(1, size * 0.1)}px`;
  const w = g.measureText(text).width + size * 1.1, h = size * 1.5;
  g.fillStyle = 'rgba(20, 24, 32, 0.3)'; g.fillRect(x - w / 2 + 3, y - h / 2 + 4, w, h);
  g.fillStyle = bg; g.fillRect(x - w / 2, y - h / 2, w, h);
  g.strokeStyle = edge; g.lineWidth = Math.max(1.4, size * 0.09); g.strokeRect(x - w / 2 + 3, y - h / 2 + 3, w - 6, h - 6);
  g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(x - w / 2, y - h / 2, w, h);
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
  g.fillText(text, x, y + size * 0.05);
  g.restore();
}

/** Stencil-style painted text (on the ground or a hull): bone paint, no plate. */
export function painted(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, rot = 0, spacing = 0.12): void {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.font = `800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  (g as unknown as { letterSpacing: string }).letterSpacing = `${size * spacing}px`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 0, 0);
  g.restore();
}
