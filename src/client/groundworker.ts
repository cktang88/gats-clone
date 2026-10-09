/**
 * Bakes a map's ground layer (tilt.ts: the floor, occlusion and shadows) off the main thread, on an OffscreenCanvas, and hands it
 * back as a bitmap: the menu's attract mode (attract.ts) bakes each map it shows here, so the menu never stops for a bake. Built
 * to public/ground.js. The floor painters reach for `document` only to make scratch canvases (grain.ts), which an OffscreenCanvas
 * stands in for; the game's typeface is loaded here too, so painted lettering measures and draws as it does on the page.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToGround>) => void) | null;
  postMessage: (m: FromGround, transfer?: Transferable[]) => void;
  fonts?: FontFaceSet;
  document?: unknown;
};
scope.document ??= { createElement: () => new OffscreenCanvas(1, 1) };

import type { WallView } from '../shared/protocol.ts';
import type { MapId } from '../shared/maps.ts';
import { floorPlanOf, portablePlan, type FloorPlan } from './floor.ts';
import { groundLayerSide, groundTransform, mapSolids, paintStaticGround } from './tilt.ts';
import './themes/index.ts';

export type ToGround = { t: 'bake'; id: number; map: MapId; size: number; walls: WallView[] };
/** With the bitmap, the map's floor plan (its decor planning is long work the page then need not repeat). */
export type FromGround = { t: 'baked'; id: number; image: ImageBitmap; ms: number; plan?: FloorPlan } | { t: 'error'; id: number; message: string };

/** The page's faces (style.css), loaded once; a face that will not load leaves the fallback, as it would on the page. */
const FACES: [string, string][] = [['500', 'normal'], ['600', 'normal'], ['700', 'normal'], ['800', 'normal'], ['800', 'italic']];
let faces: Promise<unknown> | null = null;
const loadFaces = () => (faces ??= Promise.all(FACES.map(([weight, style]) => {
  try {
    const face = new FontFace('Barlow Condensed', `url(fonts/barlow-condensed-latin-${weight}-${style}.woff2)`, { weight: weight === '800' ? '800 900' : weight, style });
    scope.fonts?.add(face);
    return face.load().catch(() => null);
  } catch { return null; }
})));

scope.onmessage = async (e) => {
  const m = e.data;
  if (m.t !== 'bake') return;
  try {
    await Promise.race([loadFaces(), new Promise((r) => setTimeout(r, 3000))]);
    const t0 = performance.now();
    const c = new OffscreenCanvas(groundLayerSide(m.size), groundLayerSide(m.size));
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d OffscreenCanvas');
    groundTransform(g);
    const plan = floorPlanOf(m.map);
    paintStaticGround(g as unknown as CanvasRenderingContext2D, m.size, mapSolids(m.size, m.walls), plan);
    const image = c.transferToImageBitmap();
    scope.postMessage({ t: 'baked', id: m.id, image, ms: performance.now() - t0, ...(plan && { plan: portablePlan(plan) }) }, [image]);
  } catch (err) {
    scope.postMessage({ t: 'error', id: m.id, message: String((err as Error)?.message ?? err).slice(0, 200) });
  }
};
