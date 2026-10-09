import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COSMETICS, type Cosmetic } from '../src/shared/cosmetics.ts';
import { recordBounds, type Bounds } from '../src/client/drawbounds.ts';

/**
 * Every card's art fits its canvas: the armory's cards, the unlock reveal on the XP card (desktop and phone sizes) and the
 * weekly challenge reward all draw through preview.ts `drawItem`. Each canvas here is a recorder (drawbounds.ts) that keeps the
 * box of everything drawn into it, sprites included (each sprite canvas is a recorder too, so a sprite counts only where it
 * has ink), at a device pixel ratio of 2.
 */
const DPR = 2;
const MARGIN = 2;
type RecCanvas = { width: number; height: number; getContext: () => CanvasRenderingContext2D; inkBounds: () => Bounds | null };
const recCanvas = (): RecCanvas => {
  const rec = recordBounds();
  return { width: 0, height: 0, getContext: () => rec.ctx, inkBounds: rec.bounds };
};
class FakeMatrix { scale() { return this; } translate() { return this; } }
Object.assign(globalThis, { devicePixelRatio: DPR, DOMMatrix: FakeMatrix, document: { createElement: recCanvas } });
const { drawItem } = await import('../src/client/preview.ts');

const card = (w: number, h: number) => {
  const c = recCanvas();
  const canvas = { ...c, clientWidth: w, clientHeight: h, dataset: {}, getBoundingClientRect: () => ({ width: w, height: h }) };
  return { canvas: canvas as unknown as HTMLCanvasElement, ink: () => c.inkBounds() };
};

/** The card sizes each slot is drawn at: the armory grid (names and titles on a short strip), the reveal, and the reward. */
const SIZES = (c: Cosmetic): [string, number, number][] => [
  ['armory', 120, c.slot === 'title' || c.slot === 'nameColor' ? 40 : 64],
  ['reveal', 132, 88], ['phone reveal', 100, 64], ['reward', 140, 64],
];

for (const slot of [...new Set(COSMETICS.map((c) => c.slot))]) {
  test(`every ${slot} card draws whole inside its canvas, clear of the edges, and fills it`, () => {
    for (const c of COSMETICS.filter((x) => x.slot === slot)) {
      for (const [where, w, h] of SIZES(c)) {
        for (const now of [0, 377, 911]) {
          const { canvas, ink } = card(w, h);
          drawItem(canvas, c, now);
          assert.equal(canvas.width, w * DPR, 'the canvas is sized for the screen\'s pixel ratio');
          const b = ink();
          assert.ok(b, `${c.id} draws something on the ${where} card`);
          const at = `${c.id} on the ${where} card (${w}x${h}) at ${now} ms: ink ${JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v / DPR)])))}`;
          assert.ok(b.x0 >= MARGIN * DPR && b.y0 >= MARGIN * DPR && b.x1 <= (w - MARGIN) * DPR && b.y1 <= (h - MARGIN) * DPR, `${at} stays ${MARGIN} px inside`);
          // Not shrunk to a dot to get there: the art spans most of the card one way or the other.
          const spanW = (b.x1 - b.x0) / (w * DPR), spanH = (b.y1 - b.y0) / (h * DPR);
          assert.ok(Math.max(spanW, spanH) >= 0.6, `${at} fills the card (${spanW.toFixed(2)} x ${spanH.toFixed(2)})`);
        }
      }
    }
  });
}

test('the recorder follows transforms, clips, strokes and inked images', () => {
  const r = recordBounds();
  const g = r.ctx;
  g.translate(10, 20);
  g.scale(2, 2);
  g.beginPath();
  g.arc(0, 0, 5, 0, Math.PI * 2);
  g.fill();
  assert.deepEqual(r.bounds(), { x0: 0, y0: 10, x1: 20, y1: 30 });
  g.lineWidth = 2;
  g.stroke();
  assert.deepEqual(r.bounds(), { x0: -2, y0: 8, x1: 22, y1: 32 }, 'a stroke grows by half its width, scaled');
  g.save();
  g.beginPath();
  g.rect(0, 0, 1, 1);
  g.clip();
  g.fillRect(-100, -100, 200, 200);
  g.restore();
  assert.deepEqual(r.bounds(), { x0: -2, y0: 8, x1: 22, y1: 32 }, 'a clipped fill only counts inside its clip');
  const sprite = recCanvas();
  sprite.width = sprite.height = 100;
  sprite.getContext().fillRect(40, 40, 20, 10);
  const r2 = recordBounds();
  r2.ctx.drawImage(sprite as unknown as CanvasImageSource, 0, 0, 50, 50);
  assert.deepEqual(r2.bounds(), { x0: 20, y0: 20, x1: 30, y1: 25 }, 'an image counts only where it has ink');
});
