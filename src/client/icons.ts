import type { PerkId } from '../shared/defs.ts';
import type { TraitId } from '../shared/roles.ts';

export const PERK_ICONS: Record<PerkId, string> = {
  optics: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 2v7M12 15v7M2 12h7M15 12h7',
  thermal: 'M7 21c-3-4 3-6 0-10s3-6 0-9M12 21c-3-4 3-6 0-10s3-6 0-9M17 21c-3-4 3-6 0-10s3-6 0-9',
  ghillie: 'M12 22V11M12 11C6 11 4 7 4 3c5 0 8 3 8 8zM12 15c5 0 8-3 8-8-5 0-8 3-8 8z',
  piercing: 'M2 12h17M14 7l5 5-5 5M9 4v16',
  extended: 'M8 2h8v6l2 14h-8L8 8zM9.5 7h5M10 11.5h6M10.5 16h6',
  grip: 'M3 6h18v5H3zM9 11l-1.5 10h4.5l1-10',
  silencer: 'M1 12h4M5 8h17v8H5zM10 8v8M14 8v8M18 8v8',
  lightweight: 'M21 3C11 3 5 9 4 21M21 3c0 9-6 13-13 13M9 11h7',
  longRange: 'M2 12h3M8 12h3M14 12h6M17 8l4 4-4 4',
  quickReload: 'M19 12a7 7 0 1 1-2.1-5M19 3v4h-4M12 8v4l2.5 2.5',
  choke: 'M2 7h9l6 3v4l-6 3H2zM20 10.5l2 1.5-2 1.5',
  shield: 'M12 2l8 3v7c0 5-4 9-8 10-4-1-8-5-8-10V5z',
  thickSkin: 'M3 7l9-4 9 4M3 12l9-4 9 4M3 17l9-4 9 4',
  firstAid: 'M4 4h16v16H4zM12 8v8M8 12h8',
  marathon: 'M4 4h6v9l9 2v5H4zM4 17h15M13 8h5M13 11h3',
  steadyHands: 'M3 9h18v6H3zM10 9v6M14 9v6M12 11.5v1M6 9v2M18 9v2',
  secondWind: 'M3 8h11a3 3 0 1 0-3-3M3 13h16a3 3 0 1 1-3 3M3 18h8',
  adrenaline: 'M13 2L4 14h7l-1 8 9-12h-7z',
  bloodlust: 'M12 3C8 9 5 12 5 16a7 7 0 0 0 14 0c0-4-3-7-7-13z',
  recon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  ninja: 'M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z',
  overclock: 'M3 17a9 9 0 1 1 18 0M12 17l5-6M7 17h.01M17 17h.01M12 8v1.5',
  demolitions: 'M10 21a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM15 7l3-3M18 2v3M21 5h-3',
  fastHands: 'M19 12a7 7 0 1 1-2.1-5M19 3v4h-4M11 9l-2 4h4l-2 4',
  tracker: 'M12 21c-5-6-7-9-7-12a7 7 0 0 1 14 0c0 3-2 6-7 12zM9.5 9a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0',
  brace: 'M4 20h16M6 20l2-9h8l2 9M9 11V6h6v5',
  fragGrenade: 'M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M19 5l-3.5 3.5M8.5 15.5L5 19',
  gasGrenade: 'M7 19h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.5-1.5A4.5 4.5 0 0 0 7 19z',
  claymore: 'M3 18h18M5 18a7 7 0 0 1 14 0M12 8V4M7 10L5 7M17 10l2-3',
  knife: 'M3 21l5-5M7 17l-2-2M8 16L20 4c0 7-4 12-9 14z',
  engineer: 'M3 5h18v14H3zM3 12h18M10 5v7M15 12v7M7 12v7',
  dash: 'M2 8h6M1 12h9M2 16h6M12 5l7 7-7 7M16 5l7 7-7 7',
  radar: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2',
  healPole: 'M10 2h4v4h4v4h-4v12h-4V10H6V6h4z',
};

/** What an evolution changes (see `TRAITS` in shared/roles.ts), drawn on the evolve pick. */
export const TRAIT_ICONS: Record<TraitId, string> = {
  quickdraw: 'M4 20L20 4M14 4h6v6M3 12h5M3 16h3',
  strafe: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
  plant: 'M12 3v12M6 15h12M4 21h16',
  burst: 'M3 12h3M10 12h3M17 12h3',
  auto: 'M3 7h18M3 12h18M3 17h18',
  heavy: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M12 8v8M8 12h8',
  shove: 'M3 12h12M11 7l5 5-5 5M20 5v14',
  pierce: 'M2 12h17M14 7l5 5-5 5M9 4v16',
  blast: 'M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M19 5l-3.5 3.5M8.5 15.5L5 19',
  quiet: 'M3 10v4h4l5 4V6L7 10zM16 9l5 6M21 9l-5 6',
  close: 'M3 12h6M21 12h-6M6 9l3 3-3 3M18 9l-3 3 3 3',
  reach: 'M2 12h3M8 12h3M14 12h6M17 8l4 4-4 4',
  scope: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 2v7M12 15v7M2 12h7M15 12h7',
  spray: 'M12 21L4 5M12 21V4M12 21L20 5',
  deep: 'M8 2h8v6l2 14h-8L8 8zM9.5 7h5M10 11.5h6M10.5 16h6',
  rev: 'M3 17a9 9 0 1 1 18 0M12 17l5-6M7 17h.01M17 17h.01M12 8v1.5',
  pin: 'M12 17v5M8 4h8l-1 6 3 3H6l3-3z',
  breach: 'M6 21V3h12v18M3 21h18M14 12h1',
  fast: 'M2 8h6M1 12h9M2 16h6M12 5l7 7-7 7M16 5l7 7-7 7',
  slow: 'M7 8h10l3 13H4zM9.5 8a2.5 2.5 0 1 1 5 0',
  deploy: 'M12 3v8M12 11L6 21M12 11l6 10M12 11v10',
};

export const UI_ICONS = {
  heart: 'M12 21C5 15 2 12 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 4-3 7-10 13z',
  target: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M12 1v6M12 17v6M1 12h6M17 12h6',
  scrap: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  core: 'M12 2l7 10-7 10-7-10z',
  reload: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3v4.5H15',
  flame: 'M12 23c-4.4 0-7.5-3-7.5-7.2 0-3.6 2.4-5.6 3.9-8.8.9 1.9 1.9 3 3.1 3.3-.2-2.8.9-5.7 3.3-8.3.6 4.1 5.2 7 5.2 13 0 4.8-3.4 8-8 8z',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  clock: 'M4 13a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 9v4l3 2M9.5 2.5h5M12 2.5V5',
  down: 'M12 4v12M6 11l6 7 6-7',
  /** A head and shoulders: a player, for the Last Standing alive counter. */
  person: 'M8.5 7a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0M4.5 21c0-4.5 3.4-7.5 7.5-7.5s7.5 3 7.5 7.5z',
  /** A recon tower: a mast under a dish. */
  antenna: 'M12 10v12M8 22h8M9 22l3-12 3 12M5 4a7 7 0 0 0 9.9 9.9zM10 7l3-3',
} as const;

const paths = new Map<string, Path2D>();

/** A solid glyph, for marks that must read at a glance. */
export function fillIcon(ctx: CanvasRenderingContext2D, d: string, x: number, y: number, size: number, color: string) {
  let path = paths.get(d);
  if (!path) paths.set(d, (path = new Path2D(d)));
  const k = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

export function strokeIcon(ctx: CanvasRenderingContext2D, d: string, x: number, y: number, size: number, color: string, width = 2.2) {
  let path = paths.get(d);
  if (!path) paths.set(d, (path = new Path2D(d)));
  const k = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.stroke(path);
  ctx.restore();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function iconSvg(d: string, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
