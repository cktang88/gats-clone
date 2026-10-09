/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTRACT_MAPS, attractTier, createAttract, focusAt, framingRightOf, menuFraming, motionLevel, overBudget, SHOW, veilFor, type AttractDeps, type PaintArgs, type View, type WorkerLike } from '../src/client/attract.ts';
import { createAttractSim, peekWorld, type AttractFrame, type AttractWorld } from '../src/client/attractsim.ts';
import type { GroundPrep } from '../src/client/tilt.ts';
import type { FromWorker, ToWorker } from '../src/client/attractworker.ts';

/** A worker that runs the real attract match in-process, answering each message at once (as attractworker.ts does). */
function fakeWorker(log: ToWorker[]) {
  let sim: ReturnType<typeof createAttractSim> | null = null;
  const w: WorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      log.push(m);
      const reply = (r: FromWorker) => w.onmessage?.({ data: r });
      if (m.t === 'boot') { sim = createAttractSim(m.opts); reply({ t: 'world', world: sim.world(), tick: sim.tick }); }
      else if (m.t === 'peek') reply({ t: 'peeked', world: peekWorld(m.opts) });
      else if (m.t === 'run' && sim) {
        const frames: AttractFrame[] = [];
        for (let n = 0; sim.tick < m.upTo && n < 30; n++) frames.push(sim.step());
        if (frames.length) reply({ t: 'frames', frames: structuredClone(frames) });
      }
    },
    terminate() { this.terminated = true; sim = null; },
  };
  return w;
}

/**
 * A ground bake that takes `slices` steps, each spending its whole budget on `tick` (the rig's clock), and logs them: which map,
 * the budget each step was given, and whether a paint happened before that map's bake was whole.
 */
function fakeBakes(tick: (ms: number) => void, slices = 12) {
  const log: { map: string; budget: number }[] = [];
  const made: string[] = [];
  const prepare = (w: AttractWorld): GroundPrep => {
    made.push(w.map);
    let left = slices, cancelled = false;
    return {
      step(budget) { if (cancelled) throw new Error('a cancelled bake was stepped'); log.push({ map: w.map, budget }); tick(budget); return --left <= 0; },
      get done() { return left <= 0; },
      get last() { return undefined; },
      cancel() { cancelled = true; },
    };
  };
  return { prepare, log, made, doneFor: (map: string) => log.filter((l) => l.map === map).length >= slices };
}

function rig(over: Partial<AttractDeps> = {}) {
  const log: ToWorker[] = [];
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const timers: { f: () => void; ms: number }[] = [];
  const listeners = new Set<() => void>();
  const doc = { hidden: false, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
  const sceneEl = { style: {} as Record<string, string> };
  const vigEl = { style: {} as Record<string, string> };
  const menu = { hidden: false, dataset: {} as Record<string, string>, style: {} as Record<string, string>, querySelector: (sel: string) => (sel === '.menu-scene' ? sceneEl : vigEl) } as unknown as HTMLElement;
  const fallback = { on: false, starts: 0, start() { this.on = true; this.starts++; }, stop() { this.on = false; }, get running() { return this.on; } };
  const paints: PaintArgs[] = [];
  let restores = 0;
  const bakes = fakeBakes(() => {}, 3);
  const a = createAttract({
    prepare: bakes.prepare,
    canvas: {} as HTMLCanvasElement, ctx: {} as CanvasRenderingContext2D, menu, fallback, calm: () => false, restore: () => { restores++; },
    tier: () => ({ on: true, why: 'test', scale: 0.5, fps: 30, bots: 8 }),
    ready: () => true,
    spawn: () => { const w = fakeWorker(log); workers.push(w); return w; },
    paint: (p) => paints.push(p),
    seed: () => 11,
    doc, later: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, cancel: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    ...over,
  });
  const flush = () => { while (timers.length) timers.shift()!.f(); };
  let now = 1000;
  const view: View = { w: 1280, h: 720, dpr: 1 };
  /** Runs the page's frames for `ms` of real time at 60 Hz. */
  const run = (ms: number, v: View = view) => { for (const end = now + ms; now < end; now += 1000 / 60) a.frame(now, v); };
  const setHidden = (h: boolean) => { doc.hidden = h; for (const f of listeners) f(); };
  return { a, log, workers, menu, sceneEl, fallback, paints, flush, run, setHidden, doc, restores: () => restores, timers, bakes };
}

test('the attract match is deterministic per seed, and another seed is another film', () => {
  const film = (seed: number) => {
    const sim = createAttractSim({ seed, map: 'oldtown', bots: 8 });
    const out: string[] = [];
    for (let i = 0; i < 90; i++) { const f = sim.step(); out.push(JSON.stringify([f.snap.tick, f.snap.players.map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.hp]), f.focus, f.mark])); }
    return out;
  };
  const a = film(5), b = film(5), c = film(6);
  assert.deepEqual(a, b, 'same seed, same frames, same camera subject');
  assert.notDeepEqual(a, c, 'a different seed plays differently');
});

test('the director keeps the camera on someone fighting, and marks a nearby kill now and then for the slow motion', () => {
  const sim = createAttractSim({ seed: 3, map: 'plaza', bots: 10 });
  let marks = 0, kills = 0, onBody = 0;
  const n = 30 * 40;
  for (let i = 0; i < n; i++) {
    const f = sim.step();
    marks += f.mark ? 1 : 0;
    kills += f.snap.events.filter((e) => e.e === 'kill').length;
    if (f.focus.id === null || f.snap.players.some((p) => p.id === f.focus.id)) onBody++;
    assert.equal(f.snap.leaderboard.length, 0, 'no leaderboard in the frames');
    assert.equal(f.snap.minimap.length, 0, 'no minimap in the frames');
  }
  assert.ok(kills >= 4, `the fight is dense enough to film (${kills} kills in view in 40 s)`);
  assert.ok(marks >= 1 && marks <= 4, `a slow-motion kill now and then, not every kill (${marks})`);
  assert.equal(onBody, n, 'the camera follows a body that is in the frame, or a fallen one\'s spot');
});

test('the attract loop starts with the menu, shows the diorama until the match is ready, and stops and frees everything on Play', () => {
  const r = rig();
  r.a.start();
  assert.equal(r.fallback.on, true, 'the diorama paints at once: the menu never waits for the match');
  assert.equal(r.workers.length, 0, 'the worker starts after the first paint, not with it');
  r.flush();
  assert.equal(r.workers.length, 1);
  assert.equal(r.log[0]!.t, 'boot');
  assert.ok(ATTRACT_MAPS.includes((r.log[0] as Extract<ToWorker, { t: 'boot' }>).opts.map));
  r.run(400);
  assert.ok(r.paints.length > 0, 'the world draws once frames are in hand');
  assert.equal(r.a.state.shown, true);
  assert.equal(r.menu.dataset.attract, 'live');
  assert.equal(r.menu.style.background, 'transparent', 'the menu lets the world show through');
  assert.equal(r.sceneEl.style.opacity, '0', 'the diorama fades out over it');
  r.flush();
  assert.equal(r.fallback.on, false, 'and stops drawing once faded');
  // The look: veiled, at the tier's resolution, at most `fps` frames a second.
  assert.ok(r.paints.every((p) => p.fade === 0), 'no fade while a map plays');
  assert.ok(veilFor(0, 0) >= 0.25 && veilFor(0, 0) <= 0.35, 'a day map shows at about 65-75%, so the fight behind the menu reads as moving');
  assert.ok(veilFor(1, 0) < veilFor(0, 0) && veilFor(1, 0) >= 0.1, 'a night map is veiled less, never bare');
  assert.equal(veilFor(0.5, 1), 1, 'a map change fades to dark');
  assert.ok(r.paints.every((p) => p.scale === 0.5));
  const before = r.paints.length;
  r.run(1000);
  const drawn = r.paints.length - before;
  assert.ok(drawn >= 27 && drawn <= 31, `about 30 frames a second, not 60 (${drawn})`);
  // Play: the menu goes, and with it everything the backdrop held.
  r.menu.hidden = true;
  r.a.stop();
  assert.equal(r.workers[0]!.terminated, true, 'the worker is terminated');
  assert.equal(r.a.state.phase, 'off');
  assert.equal(r.a.state.frames, 0, 'no frames kept');
  assert.equal(r.a.state.worker, false);
  assert.equal(r.restores(), 1, 'the canvas is handed back at full size');
  assert.equal(r.menu.dataset.attract, undefined);
  assert.equal(r.menu.style.background, '');
  assert.equal(r.fallback.on, false);
  const n = r.paints.length;
  assert.equal(r.a.frame(99_999, { w: 1280, h: 720, dpr: 1 }), false, 'a stopped backdrop draws nothing and lets the page draw');
  assert.equal(r.paints.length, n);
});

test('a hidden tab pauses the backdrop completely, and it carries on when the tab comes back', () => {
  const r = rig();
  r.a.start();
  r.flush();
  r.run(500);
  const asked = r.log.length, painted = r.paints.length, drawnMs = r.a.state.drawnMs;
  r.setHidden(true);
  // menuflow.ts stops its runners when the tab hides; the menu itself is still up.
  r.a.stop();
  assert.equal(r.a.state.phase, 'paused');
  r.run(2000);
  assert.equal(r.log.length, asked, 'the worker is asked for nothing while hidden');
  assert.equal(r.paints.length, painted, 'nothing is drawn while hidden');
  assert.equal(r.a.state.drawnMs, drawnMs, 'the match clock stands still');
  assert.equal(r.workers[0]!.terminated, false, 'the match is kept for a while in case the tab comes back');
  r.setHidden(false);
  r.a.start();
  r.run(500);
  assert.ok(r.paints.length > painted, 'it draws again');
  assert.ok(r.a.state.drawnMs > drawnMs && r.a.state.drawnMs - drawnMs < 700, 'from where it stopped, without a jump');
  // Hidden for good: the kept match is let go.
  r.setHidden(true);
  r.a.stop();
  r.flush();
  assert.equal(r.a.state.phase, 'off');
  assert.equal(r.workers[0]!.terminated, true);
});

test('a slow-motion kill slows the drawn match and the camera draws in, then time runs on', () => {
  const r = rig();
  r.a.start();
  r.flush();
  let slowSteps = 0, normalSteps = 0, minR = Infinity, maxR = 0;
  for (let i = 0; i < 60 * 30 && !(r.a.state.slows > 0 && !r.a.state.slowing && slowSteps > 10 && normalSteps > 30); i++) {
    const t0 = r.a.state.drawnMs;
    r.run(1000 / 30);
    const step = r.a.state.drawnMs - t0;
    if (r.a.state.slowing) { slowSteps++; if (step > 0 && step < 1000 / 30 * 0.5) minR = Math.min(minR, r.a.state.cam!.r); }
    else if (step > 0) { normalSteps++; maxR = Math.max(maxR, r.a.state.cam!.r); }
  }
  assert.ok(r.a.state.slows >= 1, 'a kill was slowed for');
  assert.ok(slowSteps > 10 && normalSteps > 10);
  assert.ok(minR < maxR * 0.95, `the camera draws in on the kill (${minR.toFixed(0)} vs ${maxR.toFixed(0)})`);
  r.menu.hidden = true;
  r.a.stop();
});

test('the game\'s Motion setting at Reduced gets one still frame of the match, and the match is let go', () => {
  const r = rig({ calm: () => true, motion: () => 'still' });
  r.a.start();
  r.flush();
  r.run(1000);
  assert.equal(r.paints.length, 1, 'one frame, not a film');
  assert.equal(r.a.state.still, true);
  assert.equal(r.workers[0]!.terminated, true, 'nothing keeps running behind a still');
  r.run(500, { w: 900, h: 400, dpr: 1 });
  assert.equal(r.paints.length, 2, 'a new size repaints the same moment once');
  assert.equal(r.paints[0]!.snap.tick, r.paints[1]!.snap.tick);
  r.menu.hidden = true;
  r.a.stop();
});

test('the system\'s reduced motion keeps the match playing under a slow, steady camera: no drift, breathing or slow motion', () => {
  assert.equal(motionLevel(false, 'system'), 'full');
  assert.equal(motionLevel(true, 'system'), 'gentle', 'the OS asking for less motion is not a reason to stop the film');
  assert.equal(motionLevel(true, 'on'), 'still', 'the game\'s own Reduced setting is');
  const r = rig({ calm: () => true, motion: () => 'gentle' });
  r.a.start();
  r.flush();
  let lastTick = -1, ticksMoved = 0;
  for (let i = 0; i < 60 * 25; i++) {
    r.run(1000 / 60);
    const p = r.paints[r.paints.length - 1];
    if (p && p.snap.tick !== lastTick) { ticksMoved++; lastTick = p.snap.tick; }
  }
  assert.equal(r.a.state.still, false, 'not a still');
  assert.ok(r.paints.length > 25 * 25, `it keeps drawing at the tier's rate (${r.paints.length} frames in 25 s)`);
  assert.ok(ticksMoved > 25 * 20, 'and the match moves on');
  assert.equal(r.a.state.slows, 0, 'no slow-motion moments');
  // The camera's radius never breathes or draws in: it is the same in every frame.
  const rs = new Set(r.paints.map((p) => Math.round(p.cam.scale * 1000)));
  assert.equal(rs.size, 1, `one zoom throughout (${[...rs].join(', ')})`);
  r.menu.hidden = true;
  r.a.stop();
});

test('a device the film is too heavy for draws less often, then smaller, then settles on a still: the menu always answers', () => {
  let t = 0, paintMs = 25;
  const r = rig({ clock: () => t, paint: () => { t += paintMs; } });
  r.a.start();
  r.flush();
  r.run(20_000);
  assert.ok(r.a.state.steps >= 2, `it stepped down (${r.a.state.steps})`);
  assert.equal(r.a.state.still, true, 'and settled on a still');
  assert.equal(r.workers[0]!.terminated, true, 'with the match let go');
  r.menu.hidden = true;
  r.a.stop();
  t = 0; paintMs = 3;
  const ok = rig({ clock: () => t, paint: () => { t += paintMs; } });
  ok.a.start();
  ok.flush();
  ok.run(5000);
  assert.equal(ok.a.state.steps, 0, 'a cheap frame is left alone');
  assert.equal(ok.a.state.tier.fps, 30);
  ok.menu.hidden = true;
  ok.a.stop();
});

test('a device the film is hopeless on settles on a still within seconds, without drawing through every step first', () => {
  let t = 0;
  const r = rig({ clock: () => t, paint: () => { t += 70; } });
  r.a.start();
  r.flush();
  r.run(4000);
  assert.equal(r.a.state.still, true, 'still within 4 s of the reveal');
  assert.ok(r.a.state.draws <= SHOW.settleFrames + SHOW.window + 2, `after at most ${SHOW.settleFrames + SHOW.window + 2} frames (${r.a.state.draws})`);
  assert.equal(r.workers[0]!.terminated, true);
  r.menu.hidden = true;
  r.a.stop();
});

test('the governor judges the median frame, not one dear one: a capable desktop keeps its film through map changes', () => {
  // At 30 fps the budget (30% of the main thread) is 10 ms a frame.
  assert.equal(overBudget([9, 9, 9, 9, 9], 30), false, 'just under the budget stays');
  assert.equal(overBudget([11, 11, 11, 11, 11], 30), true, 'just over it counts');
  assert.equal(overBudget([6, 6, 900, 6, 6], 30), false, 'one map\'s first frame is not a slow device');
  assert.equal(overBudget([6, 30, 30, 30, 6], 30), true, 'most frames dear is');
  assert.equal(overBudget([11, 11, 11], 15), false, 'and a step down to 15 fps brings 11 ms frames within it');
  // The whole loop: 6 ms frames, but each map's first frames cost most of a second (its walls' sprites and lights).
  let t = 0, fresh = 0;
  const r = rig({ clock: () => t, paint: () => { t += fresh-- > 0 ? 900 : 6; } });
  let map: string | null = null;
  r.a.start();
  r.flush();
  for (let i = 0; i < 60 * 130 && r.a.state.maps < 3; i++) {
    r.run(1000 / 60);
    if (r.a.state.map !== map) { map = r.a.state.map; fresh = 3; }
  }
  assert.ok(r.a.state.maps >= 3, `three map changes played (${r.a.state.maps})`);
  assert.equal(r.a.state.steps, 0, 'no step down');
  assert.equal(r.a.state.still, false, 'never a still');
  assert.deepEqual([r.a.state.tier.fps, r.a.state.tier.scale], [30, 0.5], 'full rate and resolution throughout');
  r.menu.hidden = true;
  r.a.stop();
});

test('a step down is not for good: a lighter stretch of film steps back up to the device\'s own rate', () => {
  let t = 0, paintMs = 15;
  const r = rig({ clock: () => t, paint: () => { t += paintMs; } });
  r.a.start();
  r.flush();
  r.run(8000);
  assert.equal(r.a.state.tier.fps, 15, `15 ms frames at 30 fps are 45% of the main thread: it drew less often (${r.a.state.steps} steps)`);
  assert.equal(r.a.state.still, false);
  paintMs = 3;
  r.run(8000);
  assert.equal(r.a.state.tier.fps, 30, 'cheap frames again: back to 30 fps');
  assert.ok(r.a.state.ups >= 1);
  paintMs = 15;
  r.run(8000);
  assert.equal(r.a.state.still, false, 'and a dear stretch again steps down again rather than giving up');
  r.menu.hidden = true;
  r.a.stop();
});

test('a map change keeps the menu responsive: the ground bakes ahead in slices within the budget, never in a frame that draws', () => {
  let t = 0;
  const bakes = fakeBakes((ms) => { t += ms; }, 40);
  const paintsByMap: { map: string; at: number }[] = [];
  let paints = 0;
  const r = rig({ clock: () => t, prepare: bakes.prepare, paint: () => { t += 5; paints++; } });
  r.a.start();
  r.flush();
  let bakedInPaintFrame = 0, worstBakeInFrame = 0;
  for (let i = 0; i < 60 * 130 && r.a.state.maps < 2; i++) {
    const p0 = paints, b0 = bakes.log.length, t0 = t;
    r.run(1000 / 60);
    const baked = bakes.log.slice(b0).reduce((a, l) => a + l.budget, 0);
    const painted = paints > p0;
    if (painted) paintsByMap.push({ map: r.a.state.map!, at: bakes.log.length });
    if (painted && baked > 0) bakedInPaintFrame++;
    worstBakeInFrame = Math.max(worstBakeInFrame, baked);
    assert.ok(t - t0 <= Math.max(SHOW.bakeMs, 5) + 1e-9, `a frame never spends more than one slice or one draw (${t - t0} ms)`);
  }
  assert.ok(r.a.state.maps >= 2, `two map changes (${r.a.state.maps})`);
  r.run(3000);
  assert.ok(bakes.log.every((l) => l.budget === SHOW.bakeMs), 'every slice is given the bake budget');
  assert.equal(worstBakeInFrame, SHOW.bakeMs, 'at most one slice a frame');
  assert.equal(bakedInPaintFrame, 0, 'no slice in a frame the backdrop drew in');
  // The renderer never bakes a ground itself: no map is drawn before its ground bake is whole.
  for (const p of paintsByMap) {
    const done = bakes.log.slice(0, p.at).filter((l) => l.map === p.map).length;
    assert.ok(done >= 40, `${p.map} drawn only once its ground is baked (${done} of 40 slices)`);
  }
  // The next map's ground is baked while this one still plays, so the change waits for nothing.
  const maps = [...new Set(paintsByMap.map((p) => p.map))];
  assert.ok(maps.length >= 3, `three maps drawn (${maps.join(', ')})`);
  const lastOfFirst = paintsByMap.map((p) => p.map).lastIndexOf(maps[0]!);
  const nextBakedAt = bakes.log.findIndex((l) => l.map === maps[1]);
  assert.ok(nextBakedAt >= 0 && nextBakedAt < paintsByMap[lastOfFirst]!.at, 'the next map\'s ground starts baking before this map\'s last frame');
  assert.ok(bakes.made.filter((m) => m === maps[1]).length === 1, 'and is not baked twice');
  r.menu.hidden = true;
  r.a.stop();
});

test('the backdrop draws with no HUD: no names, health bars, marks or chatter over the bodies', async () => {
  const { MAPS } = await import('../src/shared/maps.ts');
  const { makeCamera } = await import('../src/client/camera.ts');
  const { drawnTags } = await import('../src/client/render.ts');
  const { createStage, drawStage } = await import('../src/client/replaystage.ts');
  const { resetLighting } = await import('../src/client/lighting.ts');
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'getTransform') return () => ({ a: 1 });
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText' || prop === 'strokeText') return (t: string) => texts.push(t);
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {}, setTransform() {} });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const g = globalThis as Record<string, unknown>;
  const had = g.document;
  g.document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }), body: { classList: { contains: () => false } } };
  try {
    const sim = createAttractSim({ seed: 2, map: 'plaza', bots: 8 });
    let f = sim.step();
    for (let i = 0; i < 30 && f.snap.players.filter((p) => p.alive).length < 3; i++) f = sim.step();
    const world = sim.world();
    const base = { myId: -1, worldSize: MAPS.plaza.size, walls: world.walls, mapId: 'plaza', lastSelf: f.focus, hurtAt: new Map(f.snap.players.map((p) => [p.id, 0])), effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, particles: (await import('../src/client/particles.ts')).createPool(), feedback: (await import('../src/client/feedback.ts')).NO_FEEDBACK, cracks: (await import('../src/client/decals.ts')).createCracks(), snaps: { snaps: [], serverClockOffset: null } } as unknown as import('../src/client/state.ts').Session;
    const stage = createStage(base, [f.snap]);
    const cam = makeCamera(f.focus, 1280, 720, 900);
    const names = f.snap.players.map((p) => p.name);
    drawStage(ctx, stage, f.snap, cam, 1, 1000, null, false);
    assert.ok(drawnTags().length > 0, 'a normal frame tags the bodies (the check below is not vacuous)');
    assert.ok(texts.some((t) => names.some((n) => t.includes(n))), 'and writes their names');
    texts.length = 0;
    drawStage(ctx, stage, f.snap, cam, 1, 1100, null, true);
    assert.deepEqual(drawnTags(), [], 'the bare frame tags no body');
    assert.deepEqual(texts.filter((t) => names.some((n) => t.includes(n))), [], 'and writes no name');
  } finally {
    g.document = had;
    resetLighting();
  }
});

test('the device tier: phones and weak machines draw at half resolution and 20 fps; no worker or data saver keeps the diorama', () => {
  const phone = attractTier({ preset: 'medium', touch: true, cores: 8, memory: 4, worker: true });
  assert.equal(phone.on, true);
  assert.ok(phone.scale <= 0.5 && phone.fps <= 20 && phone.bots <= 8);
  const desk = attractTier({ preset: 'high', touch: false, cores: 12, memory: 8, worker: true });
  assert.ok(desk.scale === 1 && desk.fps === 30);
  assert.equal(attractTier({ preset: 'low', touch: false, cores: 8, worker: true }).scale, phone.scale, 'the Low preset is drawn like a phone');
  assert.equal(attractTier({ preset: 'high', touch: false, worker: false }).on, false);
  assert.equal(attractTier({ preset: 'high', touch: false, saveData: true, worker: true }).on, false);
  assert.equal(attractTier({ preset: 'high', touch: false, memory: 2, worker: true }).on, false);
});

test('the camera frames the fight right of the menu\'s mode card, clear of it, at every size', async () => {
  const { screenToWorld } = await import('../src/client/camera.ts');
  // The card's right edge at the sizes the front page lays out (desktop, a Retina laptop, phones on their side).
  for (const [w, right] of [[1600, 610], [1440, 560], [1920, 700], [932, 400], [844, 360]] as const) {
    const f = framingRightOf(right, { w });
    assert.ok(f.x * w > right + 40, `${w} px: the subject sits right of the card (${Math.round(f.x * w)} > ${right})`);
    assert.ok(f.x >= 0.5 && f.x <= 0.7, 'centre-right, never pushed to the edge');
  }
  assert.deepEqual(framingRightOf(380, { w: 400 }), { x: 0.5, y: 0.5 }, 'a card as wide as the screen (portrait) leaves the middle');
  assert.deepEqual(menuFraming({ querySelector: () => null }, { w: 1600, h: 900, dpr: 1 }), { x: 0.5, y: 0.5 }, 'no card: the middle');
  assert.equal(menuFraming({ querySelector: () => ({ getBoundingClientRect: () => ({ left: 210, right: 610, width: 400, height: 260 }) }) }, { w: 1600, h: 900, dpr: 1 }).x, (610 + 1600) / 2 / 1600);
  // In the loop: a still frame (no easing) puts the director's subject exactly there.
  const r = rig({ calm: () => true, motion: () => 'still', framing: () => ({ x: 0.65, y: 0.54 }) });
  r.a.start();
  r.flush();
  r.run(1000);
  const p = r.paints[0]!, f = r.a.state.focus!;
  const tl = screenToWorld(p.cam, { x: 0, y: 0 }), br = screenToWorld(p.cam, { x: p.cam.w, y: p.cam.h });
  assert.ok(Math.abs((f.x - tl.x) / (br.x - tl.x) - 0.65) < 0.01 && Math.abs((f.y - tl.y) / (br.y - tl.y) - 0.54) < 0.01, 'the subject is drawn at 65% across, 54% down');
  r.menu.hidden = true;
  r.a.stop();
});

test('the camera point is eased between frames, and cuts when the director changes subject', () => {
  const frames = [{ tick: 10, focus: { x: 0, y: 0, id: 1 } }, { tick: 11, focus: { x: 30, y: 0, id: 1 } }, { tick: 12, focus: { x: 500, y: 0, id: 2 } }];
  const T = 1000 / 30;
  assert.ok(Math.abs(focusAt(frames, 10.5 * T)!.x - 15) < 1e-6);
  assert.equal(focusAt(frames, 11.5 * T)!.x, 500);
  assert.equal(focusAt([], 0), null);
});
