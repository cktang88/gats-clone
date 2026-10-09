/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasBox, fitCanvas, layerBox, visibleSize, type Fittable, type ViewportSource } from '../src/client/canvasfit.ts';
import { makeCamera, worldToScreen, type Camera } from '../src/client/camera.ts';
import { WORLD } from '../src/shared/defs.ts';

/** A canvas as the browser shows it: CSS px per backing px on each axis, from its CSS box. */
type Layer = Fittable & { style: { width: string; height: string } };
const fresh = (): Layer => ({ width: 300, height: 150, style: { width: '', height: '' } });
const cssOf = (c: Layer) => ({ w: parseFloat(c.style.width), h: parseFloat(c.style.height) });
/** Backing px per CSS px on each axis. */
const scaleOf = (c: Layer) => { const css = cssOf(c); return { x: c.width / css.w, y: c.height / css.h }; };
/** Uniform up to the rounding of one backing pixel on either axis. */
const assertUniform = (c: Layer, dpr: number, what: string) => {
  const s = scaleOf(c), css = cssOf(c);
  assert.ok(Math.abs(c.width - css.w * dpr) <= 0.5 && Math.abs(c.height - css.h * dpr) <= 0.5, `${what}: backing ${c.width}x${c.height} for ${css.w}x${css.h} at ${dpr}`);
  assert.ok(Math.abs(s.x / s.y - 1) <= 1 / Math.min(c.width, c.height), `${what}: scale ${s.x.toFixed(4)} x ${s.y.toFixed(4)}`);
};

/** What main.ts's resize and postfx.ts's frame do, in that order, for one visible area. */
function frame(game: Layer, fx: Layer, win: ViewportSource, dpr: number) {
  const { w, h } = visibleSize(win);
  fitCanvas(game, canvasBox(w, h, dpr));
  fitCanvas(fx, layerBox(game, w, h));
  return { w, h };
}

/** A window whose visualViewport can show less than the layout viewport, as iOS Safari's with its toolbar up. */
const safari = (w: number, h: number, visible = h): ViewportSource => ({ innerWidth: w, innerHeight: visible, visualViewport: { width: w, height: visible, scale: 1 } });

test('the canvas backing store matches its CSS box times the DPR at one scale on both axes', () => {
  const cases: [number, number, number][] = [
    [852, 393, 3], [852, 393, 2], [393, 852, 3], [852, 330, 2], [852, 360, 2.5], [844, 390, 3], [932, 430, 3], [932, 370, 2], [844, 300, 2],
    [1600, 900, 1], [1920, 1080, 1.25], [2560, 1440, 2], [1366, 768, 1.5], [375, 667, 2], [1, 1, 3],
  ];
  for (const [w, h, dpr] of cases) {
    const c = fresh();
    fitCanvas(c, canvasBox(w, h, dpr));
    assert.deepEqual(cssOf(c), { w, h });
    assertUniform(c, dpr, `${w}x${h}@${dpr}`);
  }
});

test('an iPhone 15 Pro rotated mid-match and its Safari toolbar showing and hiding keep both layers uniform and on top of each other', () => {
  const game = fresh(), fx = fresh();
  // index.html's fallback for the shader canvas until its first frame: 100vw x 100vh, which iOS resolves to the toolbar-collapsed viewport.
  fx.style.width = '852px'; fx.style.height = '393px';
  const dpr = 2; // the High preset's cap of the phone's 3
  const steps: [string, ViewportSource, number, number][] = [
    ['portrait', safari(393, 852), 393, 852],
    ['rotated to landscape', safari(852, 393), 852, 393],
    // The toolbar shows: only visualViewport (and innerHeight) shrink, with a visualViewport resize and no window resize.
    ['toolbar up', safari(852, 393, 340), 852, 340],
    ['tab bar too', safari(852, 393, 330), 852, 330],
    ['compact toolbar', safari(852, 393, 360), 852, 360],
    ['toolbar collapsed', safari(852, 393), 852, 393],
    ['pinch-zoomed: the window, not the zoomed visual viewport', { innerWidth: 852, innerHeight: 393, visualViewport: { width: 426, height: 196, scale: 2 } }, 852, 393],
    ['no visualViewport', { innerWidth: 844, innerHeight: 390 }, 844, 390],
  ];
  for (const [what, win, w, h] of steps) {
    frame(game, fx, win, dpr);
    assert.deepEqual(cssOf(game), { w, h }, what);
    assertUniform(game, dpr, `${what}: #game`);
    assertUniform(fx, dpr, `${what}: #fx`);
    assert.deepEqual([fx.width, fx.height, fx.style.width, fx.style.height], [game.width, game.height, game.style.width, game.style.height], `${what}: the shader layer sits on the 2D one`);
  }
});

test('fitting an unchanged box leaves the canvas alone (a resize would clear it)', () => {
  const c = fresh();
  assert.equal(fitCanvas(c, canvasBox(852, 393, 2)), true);
  assert.equal(fitCanvas(c, canvasBox(852, 393, 2)), false);
  assert.equal(fitCanvas(c, canvasBox(852, 340, 2)), true);
});

/** Where a point drawn into the world at backing px `p * dpr` of #game shows on screen through the layer that displays the world. */
const shownAt = (layer: Layer, p: { x: number; y: number }, dpr: number) => {
  const css = cssOf(layer);
  return { x: p.x * dpr * css.w / layer.width, y: p.y * dpr * css.h / layer.height };
};

test('your health ring centres on your soldier: the HUD draws it where world-to-screen puts the soldier the shader layer shows', () => {
  const dpr = 2;
  for (const [W, H, visible] of [[852, 393, 340], [852, 393, 393], [932, 430, 370], [844, 390, 300], [393, 852, 852], [1600, 900, 900]] as const) {
    const game = fresh(), fx = fresh();
    fx.style.width = `${W}px`; fx.style.height = `${H}px`;
    const { w, h } = frame(game, fx, safari(W, H, visible), dpr);
    const self = { x: 1234, y: 987 };
    const cam: Camera = makeCamera({ x: self.x + 80, y: self.y - 40 }, w, h, WORLD.viewRadius);
    const body = shownAt(fx, worldToScreen(cam, self), dpr);
    // hud.ts draws at a UI scale k: a camera k times smaller under a transform k times larger (drawHud).
    for (const k of [0.9, 1, 1.4]) {
      const hudCam: Camera = { ...cam, w: cam.w / k, h: cam.h / k, scale: cam.scale / k };
      const ring = worldToScreen(hudCam, self);
      const ringOnScreen = { x: ring.x * k * dpr * cssOf(game).w / game.width, y: ring.y * k * dpr * cssOf(game).h / game.height };
      assert.ok(Math.hypot(ringOnScreen.x - body.x, ringOnScreen.y - body.y) < 0.01, `${W}x${visible} k ${k}: ring (${ringOnScreen.x.toFixed(2)}, ${ringOnScreen.y.toFixed(2)}) vs body (${body.x.toFixed(2)}, ${body.y.toFixed(2)})`);
    }
    // A world circle stays a circle on the shader layer.
    const s = scaleOf(fx);
    assert.ok(Math.abs(s.x / s.y - 1) < 0.005, `${W}x${visible}: world aspect ${(s.y / s.x).toFixed(3)}`);
  }
});
