import { WORLD } from '../shared/defs.ts';
import type { MapId } from '../shared/maps.ts';
import type { Snapshot } from '../shared/protocol.ts';
import type { AttractFrame, AttractWorld, Focus, Mark } from './attractsim.ts';
import type { FromWorker, ToWorker } from './attractworker.ts';
import { makeCamera, viewAspect, type Camera } from './camera.ts';
import { createCracks } from './decals.ts';
import { NO_FEEDBACK } from './feedback.ts';
import { NO_FIRING } from './fire.ts';
import { EMPTY_BUFFER, TICK_MS } from './interp.ts';
import { resetLighting } from './lighting.ts';
import { enterMap } from './mapscope.ts';
import { NO_MOMENTS } from './moments.ts';
import { createPool } from './particles.ts';
import { holdForAttract, processFrame, skipFrame } from './postfx.ts';
import { NO_PREDICTION } from './predict.ts';
import { effectivePreset, probing } from './qualityrt.ts';
import type { PresetId } from './quality.ts';
import { mapWallsKey, nightAmount } from './render.ts';
import { createGroundAhead } from './groundahead.ts';
import type { GroundPrep } from './tilt.ts';
import { settings } from './settings.ts';
import { frameAt, serverMs } from './replaybuf.ts';
import { advanceStage, createStage, drawStage, type Stage } from './replaystage.ts';
import { dilatedView, intensityAt, speedAt, SLOWMO } from './slowmo.ts';
import type { Session } from './state.ts';

/**
 * The menu's attract mode: a live bot match behind the menu, drawn by the real renderer and lighting, so the first screen shows what
 * the game looks like. The match runs in a worker (attractworker.ts, attractsim.ts); this half takes its frames, plays their events
 * through a replay stage (replaystage.ts: impacts, muzzle flashes, bodies falling, as the killcam does), and draws them on the game
 * canvas under the menu with a slow camera, a fade to the next map every `mapMs`, and now and then a slow-motion kill.
 *
 * - It costs nothing until the menu has painted and Auto has timed the first frames (`probing`), and until then the menu's own
 *   diorama (menuscene.ts) stands in; then the world fades in under it. No HUD, names, numbers or sound (the page's sound sink is
 *   closed in the menu); the menu's march plays on.
 * - It draws at most `fps` frames a second at a fraction of the screen's resolution (`attractTier`), and asks the worker for ticks
 *   only as far as it will draw, so it does nothing while the tab is hidden. A hidden tab pauses it; a match (or any stop with the
 *   menu gone) ends it: the worker is terminated, the map's art caches let go and the canvas handed back at full size.
 * - A map's ground layer (tilt.ts: the floor, occlusion and shadows, baked once per map) is baked ahead, the next map's while
 *   this one plays: in a worker on an OffscreenCanvas where the browser has one, else on the page a few ms a frame
 *   (groundahead.ts), so a map change never stops the menu for a bake; the next map fades in only once its ground is whole.
 * - Reduced motion from the system keeps the match playing under a camera that only eases slowly after the fight (no drift,
 *   breathing, slow motion or zoom); the game's own Motion setting at Reduced gets one still frame and nothing after it.
 */

export const ATTRACT_MAPS: readonly MapId[] = ['market', 'causeway', 'plaza', 'museum', 'oldtown', 'subpen'];

export const SHOW = {
  /** How long each map plays (drawn match time), and the fades between maps and in from the menu's diorama. */
  mapMs: 38_000, fadeOutMs: 700, fadeInMs: 1100, crossMs: 900,
  /**
   * How much of a day map shows through: the rest is a dark veil, so the menu's plates stay readable over it. A night map is dark
   * already, and its lamps are the show, so the veil lifts by `nightLift` of itself there.
   */
  opacity: 0.7, nightLift: 0.6,
  /** The menu's own vignette is eased while the world shows, so the edges, where the plates leave the world bare, are not lost. */
  vignette: 0.4,
  /** How far ahead of what is drawn the match is asked to run (a kill must be known before the clock reaches it, to slow for it). */
  leadMs: 900,
  /** Wait this long after the menu shows before starting the worker, so its start never competes with the menu's first paint. */
  bootDelayMs: 350,
  /** The longest the backdrop waits for Auto's first-frames timing (`probing`) once its match is ready. */
  probeWaitMs: 6000,
  /** A hidden tab keeps the match this long in case it comes back, then lets it go. */
  pauseKeepMs: 60_000,
  /** The camera: how wide it looks (times the normal view), how slowly it eases (time constant), and its slow drift and breathing. */
  zoom: 1.12, easeMs: 950, driftPx: 70, breathe: 0.05,
  /** The slow-motion moment: longer and deeper than a match's own, since it is the show. */
  slow: { ...SLOWMO, rate: 0.22, rampInMs: 160, durationMs: 1900, rampOutMs: 420 },
  /** Start slowing this long (drawn ms) before the kill, so the shot is already in the air when time slows. */
  slowLeadMs: 260,
  /**
   * The governor: the share of the main thread the backdrop may take; how many drawn frames its cost is judged over (the median,
   * so one dear frame, a map's first, never counts); how many frames in a row over it count; how many frames after a map change
   * (or the reveal) are not judged at all, while the map's art is first drawn; and the steps down before a still.
   */
  budget: 0.3, window: 31, overFrames: 40, settleFrames: 20, minFps: 15, minScale: 0.38,
  /** A step back up needs the frames to fit this share of the budget there, so it never steps straight back down. */
  upShare: 0.6,
  /** How long (real ms) a frame may spend baking the ground ahead, and how long before a map change the next map's starts. */
  bakeMs: 4, prebakeMs: 26_000,
  /** The longest a map plays on past `mapMs` waiting for the next map's ground. */
  holdMs: 30_000,
  /** How often (ms) the camera re-reads where the menu's card sits, to frame the fight clear of it. */
  frameEveryMs: 1000,
  /** Under the system's reduced motion the camera eases after its subject this many times slower. */
  gentleEase: 3,
} as const;

export type AttractTier = { on: boolean; why: string; /** Canvas pixels per CSS pixel. */ scale: number; fps: number; bots: number };
export type DeviceEnv = { preset: PresetId; touch: boolean; cores?: number; memory?: number; saveData?: boolean; worker: boolean };

/**
 * What this device can spend on the backdrop. It is behind a veil, so it never needs the screen's full resolution: a strong desktop
 * draws it at one canvas pixel per CSS pixel, a middling one at three quarters, and a phone or weak machine at half, at 20
 * frames a second and with fewer bots. No worker, data saver or very little memory keeps the static diorama instead.
 */
export function attractTier(env: DeviceEnv): AttractTier {
  if (!env.worker) return { on: false, why: 'no module workers', scale: 0, fps: 0, bots: 0 };
  if (env.saveData) return { on: false, why: 'data saver', scale: 0, fps: 0, bots: 0 };
  if (env.memory !== undefined && env.memory <= 2) return { on: false, why: `${env.memory} GB memory`, scale: 0, fps: 0, bots: 0 };
  const weak = env.touch || env.preset === 'low' || (env.cores !== undefined && env.cores <= 4) || (env.memory !== undefined && env.memory <= 4);
  if (weak) return { on: true, why: env.touch ? 'phone or tablet' : 'modest device', scale: 0.5, fps: 20, bots: 8 };
  if (env.preset === 'medium') return { on: true, why: 'medium preset', scale: 0.75, fps: 30, bots: 10 };
  return { on: true, why: `${env.preset} preset`, scale: 1, fps: 30, bots: 12 };
}

function deviceTier(): AttractTier {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return attractTier({
    preset: effectivePreset(),
    touch: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    cores: nav.hardwareConcurrency || undefined,
    memory: nav.deviceMemory,
    saveData: !!nav.connection?.saveData,
    worker: typeof Worker !== 'undefined',
  });
}

export type WorkerLike = { postMessage(m: ToWorker): void; terminate(): void; onmessage: ((e: { data: FromWorker }) => void) | null; onerror: ((e: unknown) => void) | null };
type Runner = { start(): void; stop(): void; readonly running: boolean };
export type View = { w: number; h: number; dpr: number };
/** `fade` is how far a map change has faded the picture to dark, 0 to 1. */
export type PaintArgs = { stage: Stage; snap: Snapshot; cam: Camera; scale: number; now: number; view: View; fade: number };

/** The veil's alpha over a map `night` dark (0 day to 1 night), faded `fade` of the way to black. */
export function veilFor(night: number, fade: number): number {
  const show = 1 - (1 - SHOW.opacity) * (1 - SHOW.nightLift * Math.min(1, Math.max(0, night)));
  return 1 - show * (1 - Math.min(1, Math.max(0, fade)));
}
type Doc = { readonly hidden: boolean; addEventListener(t: 'visibilitychange', f: () => void): void; removeEventListener(t: 'visibilitychange', f: () => void): void };

/** How much motion the backdrop may show: all of it; a live match under a slow camera (the system asks for less); one still. */
export type MotionLevel = 'full' | 'gentle' | 'still';
/** The system's reduced motion keeps a gently moving match; only the game's own Motion setting at Reduced asks for a still. */
export const motionLevel = (reduced: boolean, setting: string): MotionLevel => (!reduced ? 'full' : setting === 'on' ? 'still' : 'gentle');

/** The governor's verdict on recent frames: their median cost (ms) times the frame rate, against the budget's share of a second. */
export function overBudget(costs: readonly number[], fps: number, budget = SHOW.budget): boolean {
  if (!costs.length) return false;
  const sorted = [...costs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]! * fps > 1000 * budget;
}

/** Whether the median frame of `costs`, scaled down to the lowest rate and resolution the governor steps to, would still take more than half again the budget. */
export function hopeless(costs: readonly number[], tier: Pick<AttractTier, 'fps' | 'scale'>): boolean {
  if (!costs.length || tier.scale <= 0) return false;
  const sorted = [...costs].sort((a, b) => a - b);
  const at = (Math.min(tier.scale, SHOW.minScale) / tier.scale) ** 2;
  return sorted[Math.floor(sorted.length / 2)]! * at * Math.min(tier.fps, SHOW.minFps) > 1000 * SHOW.budget * 1.5;
}

/**
 * Where the camera should put its subject, as fractions of the view: midway across the bare world right of the menu's mode card
 * (the card sits bottom left; the plates above it are short), a little below the middle. With no card in sight, the middle.
 */
export function menuFraming(menu: { querySelector(s: string): unknown }, view: View): { x: number; y: number } {
  const card = menu.querySelector('#mode-pick') as { getBoundingClientRect?: () => { left: number; right: number; width: number; height: number } } | null;
  const r = card?.getBoundingClientRect?.();
  if (!r || r.width <= 0 || r.height <= 0 || view.w <= 0) return { x: 0.5, y: 0.5 };
  return framingRightOf(r.right, view);
}
/** The framing for a card whose right edge is at `right` px: centre-right, never past 70% across, the middle when the card is wide. */
export const framingRightOf = (right: number, view: Pick<View, 'w'>): { x: number; y: number } => {
  const x = (right + view.w) / 2 / view.w;
  return right > view.w * 0.75 ? { x: 0.5, y: 0.5 } : { x: Math.min(0.7, Math.max(0.5, x)), y: 0.54 };
};

export type AttractDeps = {
  /** The game canvas (under the menu) and its context. */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  menu: HTMLElement;
  /** The menu's own diorama: it shows until the match is ready, and again whenever this is off. */
  fallback: Runner;
  calm: () => boolean;
  /** Gives the canvas back its full size (the page's resize). */
  restore: () => void;
  // Seams for the tests; the defaults are the browser's.
  tier?: () => AttractTier;
  ready?: () => boolean;
  spawn?: () => WorkerLike | null;
  paint?: (a: PaintArgs) => void;
  seed?: () => number;
  /** The clock the governor times each drawn frame with, and the ground bake its slices. */
  clock?: () => number;
  /** Where to frame the subject (fractions of the view); by default right of the menu's mode card (`menuFraming`). */
  framing?: (menu: HTMLElement, view: View) => { x: number; y: number };
  /** How much motion to show; by default from `calm` and the game's Motion setting (`motionLevel`). */
  motion?: () => MotionLevel;
  /** Starts a map's ground baking ahead (groundahead.ts: in a worker, else on the page in slices). */
  prepare?: (w: AttractWorld) => GroundPrep;
  doc?: Doc;
  later?: (f: () => void, ms: number) => unknown;
  cancel?: (h: unknown) => void;
};

export type AttractPhase = 'off' | 'booting' | 'live' | 'paused';

const spawnWorker = (): WorkerLike | null => {
  try { return new Worker(new URL('./attract.js', import.meta.url), { type: 'module' }) as unknown as WorkerLike; } catch { return null; }
};

/** A session for the replay stage: the shape the renderer reads, with no socket and nothing of a real match in it. */
function stageSession(w: AttractWorld): Session {
  const mid = { x: w.worldSize / 2, y: w.worldSize / 2 };
  return {
    ws: null as unknown as WebSocket, rejoin: { room: '', name: '', loadout: { weapon: 'assault', armor: 'medium', color: 'blue' }, token: undefined },
    myId: -1, worldSize: w.worldSize, walls: w.walls, mapId: w.map, snaps: EMPTY_BUFFER, seq: 0, shots: 0, predict: NO_PREDICTION, firing: NO_FIRING, lastSelf: mid,
    effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, rounds: [], roundCover: new Map(), pendingFx: [], pendingShots: [], lastShotAt: new Map(),
    feedback: NO_FEEDBACK, moments: NO_MOMENTS, life: null, bests: {} as Session['bests'], feed: [], chat: [], hurtAt: new Map(), cracks: createCracks(), pickSentFor: null,
    walk: { now: false, at: -Infinity }, particles: createPool(120), coreHitAt: -Infinity, building: false, buildKind: 'wall', buildTier: 1, buildGhost: null, turretAims: new Map(),
  };
}

/** The default painter: the world through the real renderer and shader pass, at `scale`, then the veil over it. */
function paintFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, a: PaintArgs): void {
  const W = Math.max(2, Math.round(a.view.w * a.scale)), H = Math.max(2, Math.round(a.view.h * a.scale));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  drawStage(ctx, a.stage, a.snap, a.cam, a.scale, a.now, null, true);
  const lit = processFrame(canvas, { night: nightAmount(), storm: false }, a.now, a.view.w, a.view.h, a.scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (lit) ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = `rgba(9, 11, 15, ${veilFor(nightAmount(), a.fade).toFixed(3)})`;
  ctx.fillRect(0, 0, W, H);
}

/** Where the camera looks at drawn time `at`: the director's point, eased between the two frames either side. */
export function focusAt(frames: readonly { tick: number; focus: Focus }[], at: number): Focus | null {
  if (!frames.length) return null;
  let i = frames.findIndex((f) => f.tick * TICK_MS > at);
  if (i === -1) return frames[frames.length - 1]!.focus;
  if (i === 0) return frames[0]!.focus;
  const a = frames[i - 1]!, b = frames[i]!;
  if (a.focus.id !== b.focus.id) return b.focus;
  const k = Math.min(1, Math.max(0, (at - a.tick * TICK_MS) / TICK_MS));
  return { x: a.focus.x + (b.focus.x - a.focus.x) * k, y: a.focus.y + (b.focus.y - a.focus.y) * k, id: b.focus.id };
}

export function createAttract(d: AttractDeps) {
  const doc: Doc = d.doc ?? document;
  const later = d.later ?? ((f, ms) => setTimeout(f, ms));
  const cancel = d.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // Auto's timing of the first frames normally ends within seconds; a tab whose timing never settles does not keep the backdrop away for good.
  let bootAt = 0;
  const ready = d.ready ?? (() => !probing() || performance.now() - bootAt > SHOW.probeWaitMs);
  const paint = d.paint ?? ((a: PaintArgs) => paintFrame(d.canvas, d.ctx, a));
  const seedOf = d.seed ?? (() => (Math.random() * 0x7fffffff) | 0);
  const clock = d.clock ?? (() => performance.now());
  const motion = d.motion ?? (() => motionLevel(d.calm(), settings().motion));
  // The ground bakes in a worker where it can (groundahead.ts), else on the page a slice a frame.
  const ahead = d.prepare ? null : createGroundAhead();
  const prepare = d.prepare ?? ahead!.prepare;

  let phase: AttractPhase = 'off';
  let tier: AttractTier = { on: false, why: '', scale: 0, fps: 0, bots: 0 };
  let worker: WorkerLike | null = null;
  let bootTimer: unknown = null, pauseTimer: unknown = null, crossTimer: unknown = null;
  let seed = 0, mapIx = 0;
  let world: AttractWorld | null = null;
  /** The frames received, oldest first (the stage's clip), and the director's focus for each. */
  let clip: Snapshot[] = [];
  let foci: { tick: number; focus: Focus }[] = [];
  let marks: Mark[] = [];
  let stage: Stage | null = null;
  let asked = 0;
  /** The drawn match time (ms), the drawn effect clock (slows with it), and the real clock of the last drawn frame. */
  let at = 0, vnow = 0, lastReal: number | null = null, lastDraw = -Infinity;
  let mapFrom = 0;
  let cam: { x: number; y: number; r: number } | null = null;
  let lastFocus: Focus | null = null;
  /** Where on screen (fractions of the view) the camera puts its subject, measured from the menu now and then. */
  let framed = { x: 0.5, y: 0.5 }, framedAt = -Infinity, framedFor = '';
  const framing = (view: View, now: number) => {
    const key = `${view.w}x${view.h}`;
    if (now - framedAt < SHOW.frameEveryMs && key === framedFor) return framed;
    framedAt = now; framedFor = key;
    framed = (d.framing ?? menuFraming)(d.menu, view);
    return framed;
  };
  let slow: { at: number; mark: Mark } | null = null;
  /** The veil's fade: in from dark after a map change, out to dark before one. */
  let fade: { kind: 'in' | 'out'; at: number } | null = null;
  let shown = false, still = false, stillKey = '', waitingIn = false;
  let draws = 0, slows = 0, maps = 0;
  /**
   * The governor: the drawn frames' recent costs (the median is judged), the drawing's average cost (for the probe), how many
   * frames in a row ran over budget, how many more frames go unjudged, and how often it stepped down.
   */
  let costs: number[] = [], cost = 0, over = 0, settle = SHOW.settleFrames, steps = 0, ups = 0, governed = true;
  /** The device's own tier, which a step down can come back up to. */
  let full: AttractTier = tier;
  /** The ground being baked ahead: for which map and walls, and the bake. */
  let bake: { map: MapId; walls: string; job: GroundPrep } | null = null;
  /** The next map's world, asked for ahead (`peek`) so its ground can bake while this map plays. */
  let peeked = false;
  let painted = false, bakeSlices = 0, bakeMaxMs = 0;

  /**
   * Keeps the backdrop to `SHOW.budget` of the main thread, so the menu always answers at once: frames that stay too dear first draw
   * less often, then at a lower resolution, and then the backdrop settles on a still frame. True when it should settle now. It
   * judges the median of the last `window` frames, and none of the first `settleFrames` after a map change, so the one-off cost
   * of a map's first frames (its walls' sprites, lights) never reads as a device too slow for the film.
   */
  function govern(ms: number): boolean {
    cost = cost === 0 ? ms : cost * 0.9 + ms * 0.1;
    if (!governed) return false;
    if (settle > 0) { settle--; return false; }
    costs.push(ms);
    if (costs.length > SHOW.window) costs.shift();
    if (costs.length < Math.min(SHOW.window, 8)) return false;
    // A device the film is hopeless on (even at the lowest rate and resolution it would take half again its share) settles at once,
    // rather than drawing seconds more of frames that hold the menu up.
    if (costs.length >= SHOW.window && hopeless(costs, tier)) { steps++; return true; }
    // A step down is not for good: a full window of frames that would fit well within the budget one step up (a lighter map
    // after a heavy one) steps back up, so one dear map never leaves the film slow and small.
    if (steps > 0 && costs.length >= SHOW.window && canStepUp()) { costs = []; over = 0; return false; }
    over = overBudget(costs, tier.fps) ? over + 1 : 0;
    if (over < SHOW.overFrames) return false;
    over = 0;
    costs = [];
    steps++;
    if (tier.fps > SHOW.minFps) { tier = { ...tier, fps: SHOW.minFps }; return false; }
    if (tier.scale > SHOW.minScale) { tier = { ...tier, scale: SHOW.minScale }; cost = 0; return false; }
    return true;
  }
  /** Steps back up one step (resolution first, then rate) if the median frame, scaled to it, would take under `SHOW.upShare` of the budget. */
  function canStepUp(): boolean {
    const sorted = [...costs].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)]!;
    const room = 1000 * SHOW.budget * SHOW.upShare;
    if (tier.scale < full.scale) {
      if (median * (full.scale / tier.scale) ** 2 * tier.fps >= room) return false;
      tier = { ...tier, scale: full.scale };
    } else if (tier.fps < full.fps) {
      if (median * full.fps >= room) return false;
      tier = { ...tier, fps: full.fps };
    } else return false;
    ups++;
    return true;
  }
  /** A new map (or the reveal): its first frames go unjudged. */
  const unsettle = () => { settle = SHOW.settleFrames; costs = []; over = 0; };

  const wallsOf = (w: AttractWorld) => mapWallsKey(w.walls);
  /** Starts baking `w`'s ground unless that very ground is baking already. */
  function bakeFor(w: AttractWorld) {
    const walls = wallsOf(w);
    if (bake && bake.map === w.map && bake.walls === walls) return;
    bake?.job.cancel();
    bake = { map: w.map, walls, job: prepare(w) };
  }
  /** Whether `w`'s ground is baked whole (the renderer then takes it instead of baking it in one go). */
  const groundReady = (w: AttractWorld | null) => !!w && !!bake && bake.map === w.map && bake.walls === wallsOf(w) && bake.job.done;
  const nextMapId = () => ATTRACT_MAPS[((mapIx + 1) % ATTRACT_MAPS.length + ATTRACT_MAPS.length) % ATTRACT_MAPS.length]!;
  const bootOpts = (ix: number) => ({ seed: (seed + ix * 7919) | 0, map: ATTRACT_MAPS[(ix % ATTRACT_MAPS.length + ATTRACT_MAPS.length) % ATTRACT_MAPS.length]!, bots: tier.bots, aspect: aspectNow() });
  /** One slice of the ground bake, in a page frame the backdrop did not draw in (when it draws, it has had its share). */
  function bakeSlice() {
    if (!bake || bake.job.done || painted) return;
    const t0 = clock();
    bake.job.step(SHOW.bakeMs, clock);
    const ms = clock() - t0;
    bakeSlices++;
    if (ms > bakeMaxMs) bakeMaxMs = ms;
  }
  let sizedFor: View | null = null;

  const scene = () => d.menu.querySelector<HTMLElement>('.menu-scene');
  const vignette = () => d.menu.querySelector<HTMLElement>('.menu-vignette');

  const onVisible = () => {
    if (!doc.hidden) { lastReal = null; return; }
    // Hidden: nothing is drawn or asked for (the page's frames stop too); the match waits, then goes if the tab stays away.
    if (phase === 'live' || phase === 'booting') pause();
  };

  function boot() {
    bootTimer = null;
    if (phase !== 'booting') return;
    bootAt = performance.now();
    worker = (d.spawn ?? spawnWorker)();
    if (!worker) { phase = 'off'; return; }
    worker.onmessage = (e) => receive(e.data);
    worker.onerror = () => { const was = shown; teardown(); if (was) d.fallback.start(); };
    loadMap();
  }

  function loadMap() {
    world = null; stage = null; clip = []; foci = []; marks = []; asked = 0; slow = null; cam = null; peeked = false;
    worker?.postMessage({ t: 'boot', opts: bootOpts(mapIx) });
  }

  const aspectNow = () => (sizedFor ? viewAspect(sizedFor.w, sizedFor.h) : 16 / 9);

  function receive(m: FromWorker) {
    if (phase === 'off') return;
    if (m.t === 'error') { const was = shown; teardown(); if (was) d.fallback.start(); return; }
    if (m.t === 'peeked') {
      // The next map's walls, while this one plays: its ground starts baking now, a slice a frame.
      if (m.world.map === nextMapId()) bakeFor(m.world);
      return;
    }
    if (m.t === 'world') {
      world = m.world;
      bakeFor(world);
      if (phase === 'booting') phase = 'live';
      // The map's art caches belong to the map drawn: entering this one lets the last one's go.
      enterMap(world.map);
      clip = [];
      stage = createStage(stageSession(world), clip);
      asked = m.tick;
      ask(m.tick * TICK_MS);
      return;
    }
    if (!stage) return;
    for (const f of m.frames as AttractFrame[]) {
      if (clip.length && f.snap.tick <= clip[clip.length - 1]!.tick) continue;
      clip.push(f.snap);
      foci.push({ tick: f.snap.tick, focus: f.focus });
      if (f.mark) marks.push(f.mark);
    }
    if (clip.length && foci.length === clip.length && at === 0) { at = serverMs(clip[0]!); mapFrom = at; }
  }

  /** Asks the worker for every tick up to `leadMs` past drawn time `t`. */
  function ask(t: number) {
    const upTo = Math.floor((t + SHOW.leadMs) / TICK_MS);
    if (!worker || upTo <= asked) return;
    asked = upTo;
    worker.postMessage({ t: 'run', upTo });
  }

  /** Drops frames well behind the drawn time, keeping the stage's place in them. */
  function prune() {
    let n = 0;
    while (n < clip.length - 2 && serverMs(clip[n + 1]!) < at - 1500) n++;
    if (!n || !stage) return;
    clip.splice(0, n);
    foci.splice(0, n);
    stage.fired = Math.max(-1, stage.fired - n);
  }

  function reveal() {
    shown = true;
    holdForAttract(true);
    d.menu.dataset.attract = 'live';
    d.menu.style.background = 'transparent';
    const sc = scene();
    if (sc) { sc.style.transition = `opacity ${SHOW.crossMs}ms ease`; sc.style.opacity = '0'; }
    const vg = vignette();
    if (vg) { vg.style.transition = `opacity ${SHOW.crossMs}ms ease`; vg.style.opacity = String(SHOW.vignette); }
    crossTimer = later(() => { crossTimer = null; if (shown) d.fallback.stop(); }, SHOW.crossMs + 50);
  }

  function unreveal() {
    if (crossTimer !== null) { cancel(crossTimer); crossTimer = null; }
    if (!shown) return;
    shown = false;
    holdForAttract(false);
    delete d.menu.dataset.attract;
    d.menu.style.background = '';
    const sc = scene();
    if (sc) { sc.style.transition = ''; sc.style.opacity = ''; }
    const vg = vignette();
    if (vg) { vg.style.transition = ''; vg.style.opacity = ''; }
    skipFrame();
  }

  /** Lets everything go: the worker, the frames, the map's caches and lights, and the canvas back at full size. */
  function teardown() {
    for (const t of [bootTimer, pauseTimer]) if (t !== null) cancel(t);
    bootTimer = pauseTimer = null;
    worker?.terminate();
    worker = null;
    const hadWorld = world !== null || shown;
    bake?.job.cancel();
    bake = null; peeked = false;
    ahead?.close();
    world = null; stage = null; clip = []; foci = []; marks = []; asked = 0; at = 0; cam = null; slow = null; fade = null; waitingIn = false;
    still = false; stillKey = ''; cost = 0; over = 0; steps = 0; ups = 0; costs = []; settle = SHOW.settleFrames;
    unreveal();
    phase = 'off';
    if (hadWorld) {
      enterMap(undefined);
      resetLighting();
    }
    if (sizedFor) { sizedFor = null; d.restore(); }
  }

  function pause() {
    if (phase !== 'live' && phase !== 'booting') return;
    if (bootTimer !== null) { cancel(bootTimer); bootTimer = null; }
    phase = 'paused';
    lastReal = null;
    pauseTimer = later(() => { pauseTimer = null; if (phase === 'paused') { d.fallback.stop(); teardown(); } }, SHOW.pauseKeepMs);
  }

  /** Real ms `now` → one drawn frame (or nothing yet). */
  function draw(now: number, view: View): boolean {
    if (!stage || !clip.length || foci.length !== clip.length) return false;
    const newest = serverMs(clip[clip.length - 1]!);
    if (!shown) {
      // Wait for a little lead in hand, the map's ground baked (a slice a frame) and Auto's first timing before the world replaces the diorama.
      if (!ready() || newest - at < SHOW.leadMs * 0.5 || !groundReady(world)) return false;
      // The diorama cross-fades straight to the world (menu.css's plates stay put over both).
      reveal();
      unsettle();
      vnow = now;
    }
    const level = motion();
    // `calm`: one still frame. `gentle`: the match plays on, with no camera moves of the film's own.
    const calm = level === 'still', gentle = level !== 'full';
    if (still && stillKey === `${view.w}x${view.h}`) return true;
    if (!calm && now - lastDraw < 1000 / tier.fps - 2) return true;
    const dt = lastReal === null ? 0 : Math.min(100, Math.max(0, now - lastReal));
    lastReal = now;
    lastDraw = now;

    let speed = 1;
    while (marks.length && marks[0]!.at < at - 200) marks.shift();
    if (!gentle && !slow && marks.length && at >= marks[0]!.at - SHOW.slowLeadMs) { slow = { at: now, mark: marks.shift()! }; slows++; }
    if (slow) {
      const t = now - slow.at;
      speed = speedAt(t, SHOW.slow);
      if (t >= SHOW.slow.durationMs) slow = null;
    }
    if (!calm) {
      at = Math.min(newest, at + dt * speed);
      vnow += dt * speed;
    }
    ask(at);
    advanceStage(stage, at, vnow);
    prune();
    const snap = frameAt(clip, at);
    if (!snap) return false;

    // The camera: eased toward the director's subject, drifting a little and breathing in and out, drawn in on a slow-motion kill.
    const f = focusAt(foci, at) ?? { x: world!.worldSize / 2, y: world!.worldSize / 2, id: null };
    const drift = gentle ? { x: 0, y: 0 } : { x: SHOW.driftPx * Math.sin(vnow / 7300), y: SHOW.driftPx * 0.6 * Math.cos(vnow / 9100) };
    const base = WORLD.viewRadius * SHOW.zoom * (1 + (gentle ? 0 : SHOW.breathe * Math.sin(vnow / 11_000)));
    const intensity = slow ? intensityAt(now - slow.at, SHOW.slow) : 0;
    const dv = dilatedView({ x: f.x + drift.x, y: f.y + drift.y }, slow ? slow.mark : null, base, intensity, gentle);
    // The fight is framed where the menu leaves the world bare (right of the mode card), not under the card.
    const fr = framing(view, now);
    const sc = makeCamera(dv.center, view.w, view.h, dv.radius).scale;
    const want = { center: { x: dv.center.x - ((fr.x - 0.5) * view.w) / sc, y: dv.center.y - ((fr.y - 0.5) * view.h) / sc }, radius: dv.radius };
    lastFocus = f;
    const k = cam === null || calm ? 1 : 1 - Math.exp(-dt / (SHOW.easeMs * (gentle ? SHOW.gentleEase : 1)));
    cam = cam === null ? { x: want.center.x, y: want.center.y, r: want.radius } : { x: cam.x + (want.center.x - cam.x) * k, y: cam.y + (want.center.y - cam.y) * k, r: cam.r + (want.radius - cam.r) * Math.max(k, intensity > 0 ? 0.25 : 0) };

    // The next map: its walls asked for ahead so its ground bakes while this one plays; then fade to dark once it is baked (or
    // has been waited for long enough), swap while dark, and fade back in once its frames and ground are in hand.
    if (!calm && !peeked && worker && at - mapFrom >= SHOW.mapMs - SHOW.prebakeMs) { peeked = true; worker.postMessage({ t: 'peek', opts: bootOpts(mapIx + 1) }); }
    const nextBaked = !!bake && bake.map === nextMapId() && bake.job.done;
    if (!calm && !fade && at - mapFrom >= SHOW.mapMs && (nextBaked || at - mapFrom >= SHOW.mapMs + SHOW.holdMs)) fade = { kind: 'out', at: now };
    let dark = 0;
    if (fade?.kind === 'in') { dark = 1 - Math.min(1, (now - fade.at) / SHOW.fadeInMs); if (dark <= 0) fade = null; }
    else if (fade?.kind === 'out') dark = Math.min(1, (now - fade.at) / SHOW.fadeOutMs);

    if (sizedFor?.w !== view.w || sizedFor?.h !== view.h) {
      sizedFor = { ...view };
      worker?.postMessage({ t: 'aspect', aspect: viewAspect(view.w, view.h) });
    }
    const t0 = clock();
    paint({ stage, snap, cam: makeCamera({ x: cam.x, y: cam.y }, view.w, view.h, cam.r), scale: tier.scale, now: vnow, view, fade: dark });
    painted = true;
    draws++;
    const settle = govern(clock() - t0);

    if (fade?.kind === 'out' && dark >= 1) { nextMap(); }
    if (calm || settle) {
      // Reduced motion, or a device the film is too heavy for: this frame stays; the match is let go.
      still = true;
      stillKey = `${view.w}x${view.h}`;
      worker?.terminate();
      worker = null;
      ahead?.close();
    }
    return true;
  }

  function nextMap() {
    mapIx++;
    maps++;
    at = 0;
    lastReal = null;
    loadMap();
    fade = null;
    waitingIn = true;
  }

  const api = {
    /** The menu is up (menuflow.ts calls this whenever its view changes; calling it again is free). */
    start() {
      if (phase === 'paused') {
        if (pauseTimer !== null) { cancel(pauseTimer); pauseTimer = null; }
        if (world || stage) { phase = 'live'; lastReal = null; if (!shown) d.fallback.start(); return; }
        phase = 'booting';
        bootTimer = later(boot, SHOW.bootDelayMs);
        d.fallback.start();
        return;
      }
      if (phase !== 'off') { if (!shown) d.fallback.start(); return; }
      d.fallback.start();
      tier = (d.tier ?? deviceTier)();
      full = tier;
      if (!tier.on) return;
      doc.addEventListener('visibilitychange', onVisible);
      seed = seedOf();
      mapIx = Math.abs(seed) % ATTRACT_MAPS.length;
      phase = 'booting';
      bootTimer = later(boot, SHOW.bootDelayMs);
    },
    /** The menu went away (a match) or the tab was hidden: a hidden tab pauses, anything else ends it and frees it all. */
    stop() {
      if (doc.hidden && !d.menu.hidden && phase !== 'off') { pause(); d.fallback.stop(); return; }
      d.fallback.stop();
      if (phase === 'off') return;
      doc.removeEventListener('visibilitychange', onVisible);
      teardown();
    },
    /** Called from the page's frame while the menu is up; true when this drew (or keeps) the backdrop and the page should draw nothing. */
    frame(now: number, view: View): boolean {
      if (phase !== 'live' && phase !== 'booting') return false;
      if (doc.hidden) return shown;
      painted = false;
      try {
        if (waitingIn) {
          if (!clip.length || foci.length !== clip.length || !groundReady(world)) return shown;
          waitingIn = false;
          mapFrom = at;
          fade = { kind: 'in', at: now };
          unsettle();
        }
        return draw(now, view) || shown;
      } finally {
        bakeSlice();
      }
    },
    get running() { return phase === 'live' || phase === 'booting'; },
    /** For the tests and the dev probe. */
    get state() {
      return { phase, shown, still, ready: ready(), costMs: cost, steps, ups, focus: lastFocus, framing: framed, motion: motion(), bake: bake && { map: bake.map, done: bake.job.done, via: (bake.job as { via?: string }).via ?? 'slices', workerMs: (bake.job as { workerMs?: number | null }).workerMs ?? null, slices: bakeSlices, maxMs: bakeMaxMs, last: bake.job.last }, map: world?.map ?? null, tier, drawnMs: at, newestMs: clip.length ? serverMs(clip[clip.length - 1]!) : 0, frames: clip.length, asked, draws, slows, maps, slowing: slow !== null, worker: worker !== null, cam };
    },
  };
  // The dev probe (`?dev`): the state, and the governor switched off so a capture in a software-rendered browser keeps the film running.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev')) (globalThis as { skirmishAttract?: unknown }).skirmishAttract = Object.assign(api, { ungoverned() { governed = false; } });
  return api;
}

export type Attract = ReturnType<typeof createAttract>;
