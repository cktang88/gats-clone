/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCursorLayer, crosshairShown, CURSOR_LAYER_CSS, CURSOR_LAYER_Z, LAYER, LAYER_CLASS, layerBox, ON_CLASS, REAL_CLASS, type CrosshairContext } from '../src/client/cursorlayer.ts';
import { reticleGap } from '../src/client/hud.ts';

const root = join(import.meta.dirname, '..');

/** Every z-index the page can set: every stylesheet, the page's inline styles, and the client's inline styles and `zIndex` writes. */
function zIndexes(): { where: string; z: number }[] {
  const files = [
    ...readdirSync(join(root, 'public')).filter((f) => /\.(css|html)$/.test(f)).map((f) => join('public', f)),
    ...readdirSync(join(root, 'src/client')).filter((f) => f.endsWith('.ts') && f !== 'cursorlayer.ts').map((f) => join('src/client', f)),
  ];
  const out: { where: string; z: number }[] = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const m of text.matchAll(/z-index\s*:\s*(-?\d+)|zIndex\s*=\s*['"`]?(-?\d+)/g)) out.push({ where: f, z: Number(m[1] ?? m[2]) });
  }
  return out;
}

test('the crosshair layer sits above every overlay the page has', () => {
  const all = zIndexes();
  assert.ok(all.length > 20, 'the scan found the stylesheets');
  assert.ok(all.some((x) => x.where.endsWith('pause.css') && x.z >= 60), 'the pause menu is among them');
  const top = all.reduce((a, b) => (b.z > a.z ? b : a));
  assert.ok(CURSOR_LAYER_Z > top.z, `layer ${CURSOR_LAYER_Z} is above ${top.z} in ${top.where}`);
  assert.ok(CURSOR_LAYER_Z <= 2147483647, 'a valid z-index');
  // Its own rule: fixed (out of any stacking context), never hit by a click, and that z-index.
  const rule = CURSOR_LAYER_CSS.split('\n').find((l) => l.startsWith(`.${LAYER_CLASS} `))!;
  assert.match(rule, /position: fixed/);
  assert.match(rule, /pointer-events: none/);
  assert.match(rule, new RegExp(`z-index: ${CURSOR_LAYER_Z}`));
});

test('nothing in the client uses the browser top layer, which no z-index can rise above', () => {
  for (const f of readdirSync(join(root, 'src/client')).filter((x) => x.endsWith('.ts'))) {
    const text = readFileSync(join(root, 'src/client', f), 'utf8');
    assert.doesNotMatch(text, /\.showModal\(|\.showPopover\(|popover\s*=/, `${f} opens a modal dialog or popover`);
  }
  assert.doesNotMatch(readFileSync(join(root, 'public/index.html'), 'utf8'), /\bpopover\b/);
});

test('the layer is big enough for the widest reticle, its shake and the kill marker', () => {
  const widest = reticleGap(1.4, 100_000) + 7 + 4 + 3;
  assert.ok(widest < LAYER.radius, `${widest} fits in ${LAYER.radius}`);
  assert.ok(48 + 4 < LAYER.radius, 'the kill marker streaks fit');
});

// ---- the layer itself, on a fake canvas ----

type Call = [string, ...number[]];
function fake(dpr = 2) {
  const calls: Call[] = [];
  const classes = new Set<string>();
  const canvas = { width: 0, height: 0, style: { width: '', height: '', transform: '', display: '' } };
  const ctx = {
    t: [1, 0, 0, 1, 0, 0] as number[],
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.t = [a, b, c, d, e, f]; calls.push(['setTransform', a, b, c, d, e, f]); },
    clearRect(x: number, y: number, w: number, h: number) { calls.push(['clearRect', x, y, w, h]); },
  };
  const rootEl = { classList: { toggle: (n: string, on?: boolean) => { if (on) classes.add(n); else classes.delete(n); } } };
  let ratio = dpr;
  const layer = createCursorLayer(canvas, ctx, rootEl, () => ratio);
  return { layer, canvas, ctx, classes, calls, setRatio: (r: number) => { ratio = r; } };
}
const apply = (t: number[], p: { x: number; y: number }) => ({ x: t[0]! * p.x + t[2]! * p.y + t[4]!, y: t[1]! * p.x + t[3]! * p.y + t[5]! });
const translateOf = (s: string) => s.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)!.slice(1).map(Number) as [number, number];

test('the layer follows the cursor, centred on it, its corner on a whole device pixel', () => {
  const { layer, canvas } = fake(2);
  for (const at of [{ x: 800, y: 450 }, { x: 13.3, y: 877.7 }, { x: 1599, y: 0 }]) {
    layer.frame(at, true, true);
    const [x, y] = translateOf(canvas.style.transform);
    const css = Number.parseFloat(canvas.style.width);
    assert.ok(Math.abs(x + css / 2 - at.x) <= 0.25 && Math.abs(y + css / 2 - at.y) <= 0.25, `centred on ${at.x},${at.y}`);
    assert.equal(Math.round(x * 2), x * 2, 'whole device pixel');
    assert.equal(canvas.width, css * 2, 'backed at the full pixel ratio');
    assert.ok(Math.abs(layer.probe().x - at.x) <= 0.25 && Math.abs(layer.probe().y - at.y) <= 0.25, 'the dev probe reads the same centre');
  }
});

test("the HUD's reticle and killfx's marker land on the cursor's pixel in the layer", () => {
  const { layer } = fake(2);
  const at = { x: 640.25, y: 360.5 };
  for (const k of [1, 0.8, 1.25]) {
    layer.frame(at, true, true);
    const c = layer.hud(k);
    // The HUD draws in its own units: the cursor is at `at / k` there.
    const p = apply(c.t, { x: at.x / k, y: at.y / k });
    const half = layerBox(at, 2, k).px / 2;
    assert.ok(Math.abs(p.x - half) <= 1 && Math.abs(p.y - half) <= 1, `k=${k}: ${p.x},${p.y} near ${half}`);
  }
  // killfx sets a bare device-pixel-ratio transform and draws at the point it is handed.
  layer.frame(at, true, true);
  const local = layer.local(at);
  const half = layerBox(at, 2, 1.25).px / 2;
  assert.ok(Math.abs(local.x * 2 - half) <= 1 && Math.abs(local.y * 2 - half) <= 1);
});

test('each frame clears what was drawn last frame, and nothing more', () => {
  const { layer, calls } = fake(1);
  layer.frame({ x: 100, y: 100 }, true, true);
  layer.frame({ x: 101, y: 100 }, true, true);
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 0, 'nothing drawn, nothing to clear');
  layer.hud(1);
  layer.frame({ x: 102, y: 100 }, true, true);
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 1);
  layer.frame({ x: 103, y: 100 }, true, true);
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 1);
});

test('the crosshair is the cursor only in live desktop play with nothing open that needs a real cursor', () => {
  const play: CrosshairContext = { phase: 'playing', touch: false, mouseAiming: true, paused: false, rangeOpen: false };
  assert.equal(crosshairShown(play), true);
  assert.equal(crosshairShown({ ...play, phase: 'menu' }), false, 'the menu');
  assert.equal(crosshairShown({ ...play, phase: 'dead' }), false, 'the death card');
  assert.equal(crosshairShown({ ...play, paused: true }), false, 'the pause menu');
  assert.equal(crosshairShown({ ...play, rangeOpen: true }), false, 'the range panel');
  assert.equal(crosshairShown({ ...play, touch: true }), false, 'a touch screen');
  assert.equal(crosshairShown({ ...play, mouseAiming: false }), false, 'before the mouse is seen');
});

test('hidden, the layer gives the OS cursor back; shown, it is the only cursor', () => {
  const { layer, canvas, classes } = fake(1);
  layer.frame({ x: 10, y: 10 }, true, true);
  assert.equal(canvas.style.display, '');
  assert.ok(classes.has(ON_CLASS) && !classes.has(REAL_CLASS));
  // Paused or the range panel open: in the match, the canvas shows its OS crosshair again.
  layer.frame({ x: 10, y: 10 }, false, true);
  assert.equal(canvas.style.display, 'none');
  assert.ok(!classes.has(ON_CLASS) && classes.has(REAL_CLASS));
  // The menu.
  layer.frame({ x: 10, y: 10 }, false, false);
  assert.ok(!classes.has(ON_CLASS) && !classes.has(REAL_CLASS));
  assert.match(CURSOR_LAYER_CSS, new RegExp(`html\\.${ON_CLASS} \\* \\{ cursor: none !important; \\}`));
});

test('a HUD scale above 1 grows the layer once, not every frame', () => {
  const { layer, canvas } = fake(1);
  layer.frame({ x: 500, y: 500 }, true, true);
  layer.hud(1.5);
  const grown = canvas.width;
  assert.equal(grown, LAYER.radius * 1.5 * 2);
  layer.frame({ x: 500, y: 500 }, true, true);
  assert.equal(canvas.width, grown);
});
