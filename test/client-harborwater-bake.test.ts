/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapDef } from '../src/shared/maps.ts';

/**
 * A document whose 2D canvases record what is drawn: the first pixel read (the water mask `prepWater` rasterizes) comes back all
 * water, every later one (the hull mask) empty, so the plain water has tiles to bake.
 */
function fakeDocument() {
  let reads = 0;
  const drawn: unknown[] = [];
  const tiles: { width: number }[] = [];
  const ctx2d = (c: { width: number }) => new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => {
      if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(reads++ === 0 ? 255 : 0) });
      if (k === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'putImageData') return () => { tiles.push(c); };
      return () => {};
    },
    set: () => true,
  });
  const document = { createElement: () => { const c = { width: 0, height: 0, getContext: (kind: string) => (kind === '2d' ? ctx2d(c) : null) }; return c; } };
  const ctx = new Proxy({} as Record<string, unknown>, { get: (_t, k) => (k === 'drawImage' ? (img: unknown) => { drawn.push(img); } : () => {}), set: () => true });
  return { document, ctx: ctx as unknown as CanvasRenderingContext2D, drawn, tiles };
}

test('the plain water paints a tile a band of rows at a time: no frame stalls on a whole tile, and the bands add up to the whole', async () => {
  const fake = fakeDocument();
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, location: g.location };
  Object.assign(globalThis, { document: fake.document, location: { search: '' } });
  try {
    const { drawWater, paintWaterTile, prepWater, setWaterPlan, waterStats } = await import('../src/client/themes/harborwater.ts');
    setWaterPlan({ gl: false, tier: 0 });
    const map = { name: 'bake-test', size: 600, polys: [] } as unknown as MapDef;
    const view = { x0: 0, y0: 0, x1: 500, y1: 500 };

    // Whole tile versus bands: the same pixels.
    const prep = prepWater(map, []);
    const side = 516;
    const whole = new Uint8ClampedArray(side * side * 4), banded = new Uint8ClampedArray(side * side * 4);
    const wet = paintWaterTile(prep, 0, 0, whole);
    let bandedWet = false;
    for (let row = 0; row < side; row += 37) bandedWet = paintWaterTile(prep, 0, 0, banded, row, Math.min(side, row + 37)) || bandedWet;
    assert.ok(wet, 'the test map is water');
    assert.equal(bandedWet, wet);
    assert.deepEqual(banded, whole);

    // A tile costs far more than a frame's share, so the first frame shows the deep tone and the tile lands some frames later.
    const t0 = performance.now();
    drawWater(fake.ctx, 0, view, map, [], []);
    const firstMs = performance.now() - t0;
    assert.equal(waterStats.mode, '2d');
    const finished = (): number => fake.tiles.length;
    assert.equal(finished(), 0, 'no tile is finished in the first frame');
    assert.ok(firstMs < 100, `the first frame took ${firstMs.toFixed(1)} ms`);
    let frames = 1;
    while (finished() === 0 && frames < 2000) { drawWater(fake.ctx, frames * 16, view, map, [], []); frames++; }
    assert.ok(finished() === 1 && frames > 1, `the tile landed after ${frames} frames`);
    fake.drawn.length = 0;
    drawWater(fake.ctx, frames * 16, view, map, [], []);
    assert.ok(fake.drawn.includes(fake.tiles[0]), 'and is drawn from then on');
  } finally {
    Object.assign(globalThis, saved);
  }
});
