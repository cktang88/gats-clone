import type { AttractWorld } from './attractsim.ts';
import { MAPS } from '../shared/maps.ts';
import { adoptFloorPlan, floorPlanOf } from './floor.ts';
import type { FromGround, ToGround } from './groundworker.ts';
import { mapSolids, offerGround, prepareGround, type GroundPrep } from './tilt.ts';

/**
 * Bakes the ground of the maps the menu's attract mode is about to show, ahead of drawing them, so the menu never stops for a
 * bake. Where the browser has a 2D OffscreenCanvas the bake runs in a worker (groundworker.ts, public/ground.js) and costs the
 * page nothing but taking the finished bitmap; elsewhere, or if the worker fails, it falls back to baking on the page in slices
 * of a few ms a frame (tilt.ts `prepareGround`, bakeslice.ts). Either way the renderer's ground cache takes the finished layer.
 */
export type GroundWorkerLike = { postMessage(m: ToGround): void; terminate(): void; onmessage: ((e: { data: FromGround }) => void) | null; onerror: ((e: unknown) => void) | null };
export type AheadPrep = GroundPrep & { readonly via: 'worker' | 'slices'; readonly workerMs: number | null };

const offscreen2d = (): boolean => {
  try { return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { return false; }
};
const spawnGround = (): GroundWorkerLike | null => {
  if (typeof Worker === 'undefined' || !offscreen2d()) return null;
  try { return new Worker(new URL('./ground.js', import.meta.url), { type: 'module' }) as unknown as GroundWorkerLike; } catch { return null; }
};

export type GroundAheadDeps = {
  spawn?: () => GroundWorkerLike | null;
  /** The page-side bake, sliced (tilt.ts `prepareGround`). */
  sliced?: (w: AttractWorld) => GroundPrep;
  /** Hands a finished bitmap to the ground cache (tilt.ts `offerGround`); returns its withdrawal. */
  offer?: (w: AttractWorld, image: ImageBitmap) => () => void;
};

export function createGroundAhead(d: GroundAheadDeps = {}) {
  const spawn = d.spawn ?? spawnGround;
  const sliced = d.sliced ?? ((w: AttractWorld) => prepareGround(w.worldSize, mapSolids(w.worldSize, w.walls), floorPlanOf(w.map)));
  const offer = d.offer ?? ((w: AttractWorld, image: ImageBitmap) => offerGround(w.worldSize, mapSolids(w.worldSize, w.walls), MAPS[w.map].walls, image));
  /** The worker: not tried yet (undefined), running, or none (null: unsupported or failed, so every bake is sliced). */
  let worker: GroundWorkerLike | null | undefined;
  let nextId = 1;
  const waiting = new Map<number, (m: FromGround | null) => void>();

  const broken = () => {
    worker?.terminate();
    worker = null;
    for (const f of [...waiting.values()]) f(null);
    waiting.clear();
  };
  const ensure = (): GroundWorkerLike | null => {
    if (worker !== undefined) return worker;
    worker = spawn();
    if (worker) {
      worker.onmessage = (e) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); f?.(e.data); };
      worker.onerror = () => broken();
    }
    return worker;
  };

  function prepare(w: AttractWorld): AheadPrep {
    let fallback: GroundPrep | null = null, done = false, cancelled = false, workerMs: number | null = null;
    let withdraw: (() => void) | null = null;
    const toSlices = () => { if (!cancelled && !done && !fallback) fallback = sliced(w); };
    const wk = ensure();
    if (wk) {
      const id = nextId++;
      waiting.set(id, (m) => {
        if (!m || m.t === 'error') { if (m) broken(); toSlices(); return; }
        if (cancelled) { m.image.close?.(); return; }
        // The worker planned the map's floor to paint it: the page takes that plan rather than planning it again in a frame.
        if (m.plan) adoptFloorPlan(w.map, m.plan);
        withdraw = offer(w, m.image);
        workerMs = m.ms;
        done = true;
      });
      wk.postMessage({ t: 'bake', id, map: w.map, size: w.worldSize, walls: w.walls });
    } else toSlices();
    return {
      step(budgetMs, clock) { if (done) return true; return fallback ? fallback.step(budgetMs, clock) : false; },
      get done() { return done || (fallback?.done ?? false); },
      get last() { return fallback?.last; },
      get via() { return fallback ? 'slices' as const : 'worker' as const; },
      get workerMs() { return workerMs; },
      cancel() { cancelled = true; withdraw?.(); fallback?.cancel(); },
    };
  }

  return {
    prepare,
    /** Lets the worker go (the menu's backdrop ended); a later bake starts a new one. */
    close() { waiting.clear(); worker?.terminate(); worker = undefined; },
    get worker() { return !!worker; },
  };
}
