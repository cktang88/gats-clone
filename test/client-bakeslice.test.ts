/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opsOf, recordPaint, replayAll, replaySlice, SLICE, startReplay, Unrecordable, type Box, type Surface } from '../src/client/bakeslice.ts';

/** A real-ish context for the recorder: it only has to make gradients and patterns, measure text and say its transform. */
function maker(): CanvasRenderingContext2D {
  return {
    canvas: { width: 1000, height: 1000 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({ pattern: true }),
    measureText: (t: string) => ({ width: t.length * 7 }),
    fillStyle: '#000', filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, miterLimit: 10, shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
}

/** A seeded painter over a 1000 px canvas: a full fill, a few thousand specks, a blurred pass, a transformed and a clipped draw. */
function painter(g: CanvasRenderingContext2D) {
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#222';
  g.fillRect(0, 0, 1000, 1000);
  for (let i = 0; i < 3000; i++) { g.fillStyle = rand() < 0.5 ? '#333' : '#444'; g.fillRect(rand() * 1000, rand() * 1000, 2, 2); }
  g.save();
  g.filter = 'blur(3px)';
  g.beginPath();
  for (let i = 0; i < 40; i++) g.rect(rand() * 900, rand() * 900, 60, 30);
  g.fill();
  g.restore();
  g.save();
  g.translate(10, 20);
  g.scale(2, 2);
  g.fillRect(0, 0, 10, 10);
  g.restore();
  g.save();
  g.beginPath();
  g.rect(0, 500, 1000, 100);
  g.clip();
  g.fillStyle = g.createLinearGradient(0, 0, 0, 1000);
  g.fillRect(0, 0, 1000, 1000);
  g.restore();
}

type Call = { name: string; args: unknown[] };
/**
 * The canvas a replay plays onto: it logs every call and owes the clock for each pixel it is given (inside the band clip), at
 * `rate` ms a plain pixel and `blurRate` under a blur; the flush pays what is owed, as a browser rasterizes on demand.
 */
function target(clock: { t: number }, rate: number, blurRate: number) {
  const calls: Call[] = [];
  let owed = 0, filter = 'none';
  const clips: (Box | null)[] = [null];
  const stack: string[] = [];
  const area = (b: Box) => { const c = clips[clips.length - 1]; const x0 = Math.max(b[0], c?.[0] ?? 0, 0), y0 = Math.max(b[1], c?.[1] ?? 0, 0), x1 = Math.min(b[2], c?.[2] ?? 1000, 1000), y1 = Math.min(b[3], c?.[3] ?? 1000, 1000); return Math.max(0, x1 - x0) * Math.max(0, y1 - y0); };
  let path: Box | null = null;
  const g = new Proxy({} as Record<string, unknown>, {
    get(_, k: string) {
      return (...args: unknown[]) => {
        clock.t += 0.0005;
        calls.push({ name: k, args });
        const n = args as number[];
        if (k === 'save') { stack.push(filter); clips.push(clips[clips.length - 1]!); }
        else if (k === 'restore') { filter = stack.pop() ?? 'none'; clips.pop(); }
        else if (k === 'beginPath') path = null;
        else if (k === 'rect') path = path ? [Math.min(path[0], n[0]!), Math.min(path[1], n[1]!), Math.max(path[2], n[0]! + n[2]!), Math.max(path[3], n[1]! + n[3]!)] : [n[0]!, n[1]!, n[0]! + n[2]!, n[1]! + n[3]!];
        else if (k === 'fillRect') owed += area([n[0]!, n[1]!, n[0]! + n[2]!, n[1]! + n[3]!]) * (filter === 'none' ? rate : blurRate);
        else if (k === 'fill' && path) owed += area(path) * (filter === 'none' ? rate : blurRate);
      };
    },
    set(_, k: string, v) { calls.push({ name: `=${k}`, args: [v] }); if (k === 'filter') filter = String(v); return true; },
  }) as unknown as CanvasRenderingContext2D;
  const surface: Surface = {
    clip(x0, y0, x1, y1) { calls.push({ name: 'bandclip', args: [x0, y0, x1, y1] }); clips[clips.length - 1] = [x0, y0, x1, y1]; },
    flush() { clock.t += owed; owed = 0; },
  };
  return { g, calls, surface };
}

/** Bakes the painter in slices of `budget` ms on the fake clock; returns each slice's cost and what the canvas was given. */
function slicedBake(budget: number, rate: number, blurRate: number) {
  const rec = recordPaint(maker(), painter);
  const clock = { t: 0 };
  const { g, calls, surface } = target(clock, rate, blurRate);
  const r = startReplay(rec, 1000, 1000);
  const slices: number[] = [];
  for (let i = 0; i < 100_000 && !r.done; i++) {
    const t0 = clock.t;
    replaySlice(g, r, budget, () => clock.t, surface);
    slices.push(clock.t - t0);
  }
  return { rec, r, calls, slices };
}

test('the sliced bake never runs past its per-frame budget on a device as slow as it first guesses, and finishes', () => {
  const { r, slices } = slicedBake(4, SLICE.rate, SLICE.blurRate);
  assert.equal(r.done, true, 'it finishes');
  const worst = Math.max(...slices);
  assert.ok(worst <= 4, `no slice over 4 ms (worst ${worst.toFixed(2)} ms over ${slices.length} slices)`);
  assert.ok(slices.length > 10, 'and it really was cut up');
  // The full fill alone would cost 1000 x 1000 px x the rate = 20 ms: it was played in bands.
  assert.ok(1_000_000 * SLICE.rate > 4 * 4);
});

test('on a faster device the slicer learns to give each slice more, and on a slower one only its first slices of a kind run long', () => {
  const slow = slicedBake(4, SLICE.rate, SLICE.blurRate);
  const fast = slicedBake(4, SLICE.rate / 10, SLICE.blurRate / 10);
  assert.ok(fast.slices.length < slow.slices.length / 2, `fewer, fuller slices when pixels are cheap (${fast.slices.length} vs ${slow.slices.length})`);
  assert.ok(Math.max(...fast.slices) <= 4);
  const slower = slicedBake(4, SLICE.rate * 3, SLICE.blurRate * 3);
  assert.equal(slower.r.done, true);
  const over = slower.slices.filter((s) => s > 4).length;
  assert.ok(over <= 4, `it learns: ${over} of ${slower.slices.length} slices ran long, one or two per kind of draw`);
  assert.ok(Math.max(...slower.slices) <= 3 * 4, 'and never by more than the guess was off');
});

test('a sliced bake gives the canvas exactly the painter\'s calls, a big draw in bands that tile it once', () => {
  const { rec, calls } = slicedBake(4, SLICE.rate, SLICE.blurRate);
  const direct: Call[] = [];
  replayAll(new Proxy({}, { get: (_, k: string) => (...args: unknown[]) => direct.push({ name: k, args }), set: (_, k: string, v) => (direct.push({ name: `=${k}`, args: [v] }), true) }) as unknown as CanvasRenderingContext2D, rec);
  // Fold each banded draw (save, band clip, draw, restore) back into one draw, checking its bands tile its rows once.
  const folded: Call[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i]!.name === 'save' && calls[i + 1]?.name === 'bandclip') {
      const draw = calls[i + 2]!;
      const bands: Box[] = [];
      while (calls[i]?.name === 'save' && calls[i + 1]?.name === 'bandclip' && JSON.stringify(calls[i + 2]) === JSON.stringify(draw)) { bands.push(calls[i + 1]!.args as Box); i += 4; }
      i--;
      for (let k = 1; k < bands.length; k++) {
        assert.equal(bands[k]![1], bands[k - 1]![3], 'each band starts where the last ended');
        assert.deepEqual([bands[k]![0], bands[k]![2]], [bands[0]![0], bands[0]![2]], 'at the same columns');
      }
      assert.ok(bands.every((b) => b.every(Number.isInteger)), 'on whole pixels');
      folded.push(draw);
    } else folded.push(calls[i]!);
  }
  assert.deepEqual(folded.map((c) => c.name), direct.map((c) => c.name), 'the same calls in the same order');
  assert.deepEqual(folded, direct);
});

test('the recorder knows where each draw can reach: its transform, a blur, a clip, and compositing that touches it all', () => {
  const rec = recordPaint(maker(), (g) => {
    g.save(); g.translate(10, 20); g.scale(2, 2); g.fillRect(0, 0, 10, 10); g.restore();
    g.filter = 'blur(3px)'; g.fillRect(100, 100, 10, 10); g.filter = 'none';
    g.save(); g.beginPath(); g.rect(0, 500, 1000, 100); g.clip(); g.fillRect(0, 0, 1000, 1000); g.restore();
    g.globalCompositeOperation = 'destination-in'; g.fillRect(0, 0, 5, 5); g.globalCompositeOperation = 'source-over';
    g.beginPath(); g.arc(50, 50, 10, 0, 7); g.fill();
    g.fillText('hi', 0, 0);
    g.restore(); // one restore too many: dropped, so the caller's own state is never popped
  });
  const draws = opsOf(rec).filter((o) => o.k === 2);
  assert.deepEqual(draws.map((d) => d.box), [
    [8, 18, 32, 42],
    [100 - 2 - 9, 100 - 2 - 9, 110 + 2 + 9, 110 + 2 + 9],
    [-1, 499, 1001, 601],
    null,
    [38, 38, 62, 62],
    null,
  ]);
  assert.deepEqual(draws.map((d) => d.kind), ['fillRect', 'blur:fillRect', 'fillRect', 'fillRect', 'fill', 'fillText']);
  const names = opsOf(rec).map((o) => o.name);
  assert.equal(names.filter((n) => n === 'save').length, names.filter((n) => n === 'restore').length, 'saves and restores balance');
  assert.throws(() => recordPaint(maker(), (g) => { g.getImageData(0, 0, 1, 1); }), Unrecordable, 'a painter that reads pixels cannot be recorded');
  assert.equal(recordPaint(maker(), (g) => { g.font = '700 10px sans-serif'; assert.equal(g.measureText('abc').width, 21); }).ops, 1, 'text is measured on the real context');
});
